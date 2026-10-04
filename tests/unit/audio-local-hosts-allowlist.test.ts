// OMNIROUTE_LOCAL_AUDIO_HOSTS: operator-allowlisted in-cluster hosts (Arc Kokoro / Arc
// Whisper) are treated as local by the /v1/audio/* provider-node policy — eligible with
// AUDIO_REMOTE_PROVIDER_NODES off and no credential required — while every other remote
// host keeps the opt-in + required-key behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isLocalAudioNodeHost,
  selectAudioProviderNodes,
} from "@/app/api/v1/_shared/audioProviderNodes";
import {
  buildDynamicAudioProvider,
  isAllowlistedLocalAudioHost,
  LOCAL_AUDIO_HOSTS_ENV,
  parseLocalAudioHosts,
  type ProviderNodeRow,
} from "@omniroute/open-sse/config/audioRegistry.ts";

const LIVE_VALUE =
  "kokoro-tts.kokoro-service.svc.cluster.local,speaches.speaches-service.svc.cluster.local";
const KOKORO = "kokoro-tts.kokoro-service.svc.cluster.local";

const CLUSTER_SPEECH_NODE: ProviderNodeRow = {
  id: "openai-compatible-audio-speech-arc-kokoro",
  prefix: "arc-kokoro",
  name: "Arc Kokoro",
  baseUrl: `http://${KOKORO}:8880/v1`,
  apiType: "audio-speech",
};
const REMOTE_SPEECH_NODE: ProviderNodeRow = {
  id: "openai-compatible-audio-speech-remote",
  prefix: "remotetts",
  name: "Remote TTS",
  baseUrl: "https://stt.example.com/v1",
  apiType: "audio-speech",
};
const LOOPBACK_SPEECH_NODE: ProviderNodeRow = {
  id: "openai-compatible-audio-speech-local",
  prefix: "localtts",
  name: "Local TTS",
  baseUrl: "http://localhost:8880/v1",
  apiType: "audio-speech",
};
const SPEECH_OPTS = { audioPath: "/audio/speech", nodeApiType: "audio-speech" };

const originalEnv = process.env[LOCAL_AUDIO_HOSTS_ENV];
test.afterEach(() => {
  if (originalEnv === undefined) delete process.env[LOCAL_AUDIO_HOSTS_ENV];
  else process.env[LOCAL_AUDIO_HOSTS_ENV] = originalEnv;
});

test("parseLocalAudioHosts drops empty entries, trims, and lowercases", () => {
  assert.equal(parseLocalAudioHosts(undefined).size, 0);
  assert.equal(parseLocalAudioHosts(null).size, 0);
  assert.equal(parseLocalAudioHosts("").size, 0);
  assert.equal(parseLocalAudioHosts(" , ,").size, 0);
  assert.deepEqual(
    [
      ...parseLocalAudioHosts(
        " Kokoro-TTS.kokoro-service.svc.cluster.local , speaches.speaches-service.svc.cluster.local:8000 ,"
      ),
    ],
    [KOKORO, "speaches.speaches-service.svc.cluster.local:8000"]
  );
});

test("isAllowlistedLocalAudioHost matches exact hosts only", () => {
  assert.equal(isAllowlistedLocalAudioHost(`http://${KOKORO}:8880/v1`, LIVE_VALUE), true);
  assert.equal(isAllowlistedLocalAudioHost(`https://${KOKORO.toUpperCase()}/v1`, LIVE_VALUE), true);
  assert.equal(isAllowlistedLocalAudioHost(`http://evil-${KOKORO}:8880/v1`, LIVE_VALUE), false);
  assert.equal(isAllowlistedLocalAudioHost(`http://${KOKORO}.evil.com/v1`, LIVE_VALUE), false);
  assert.equal(isAllowlistedLocalAudioHost(`http://user:pw@${KOKORO}:8880/v1`, LIVE_VALUE), false);
  assert.equal(isAllowlistedLocalAudioHost(`ftp://${KOKORO}/v1`, LIVE_VALUE), false);
  assert.equal(isAllowlistedLocalAudioHost("not-a-url", LIVE_VALUE), false);
  assert.equal(isAllowlistedLocalAudioHost(`http://${KOKORO}:8880/v1`, ""), false);
});

test("isAllowlistedLocalAudioHost: a host:port entry matches only that port", () => {
  const raw = `${KOKORO}:8880`;
  assert.equal(isAllowlistedLocalAudioHost(`http://${KOKORO}:8880/v1`, raw), true);
  assert.equal(isAllowlistedLocalAudioHost(`http://${KOKORO}:9999/v1`, raw), false);
  assert.equal(isAllowlistedLocalAudioHost(`http://${KOKORO}/v1`, raw), false);
});

test("isLocalAudioNodeHost keeps loopback semantics when the env is unset", () => {
  delete process.env[LOCAL_AUDIO_HOSTS_ENV];
  assert.equal(isLocalAudioNodeHost("http://localhost:1234"), true);
  assert.equal(isLocalAudioNodeHost("http://[::1]:1234"), false);
  assert.equal(isLocalAudioNodeHost(`http://${KOKORO}:8880/v1`), false);
  process.env[LOCAL_AUDIO_HOSTS_ENV] = LIVE_VALUE;
  assert.equal(isLocalAudioNodeHost(`http://${KOKORO}:8880/v1`), true);
});

test("selectAudioProviderNodes admits an allowlisted cluster host with the flag off", () => {
  process.env[LOCAL_AUDIO_HOSTS_ENV] = LIVE_VALUE;
  const providers = selectAudioProviderNodes([CLUSTER_SPEECH_NODE, REMOTE_SPEECH_NODE], {
    ...SPEECH_OPTS,
    allowRemote: false,
  });
  const ids = providers.map((p) => p.id);
  assert.deepEqual(ids, ["arc-kokoro", CLUSTER_SPEECH_NODE.id]);
  assert.equal(providers[0].baseUrl, `http://${KOKORO}:8880/v1/audio/speech`);
});

test("selectAudioProviderNodes rejects the cluster host when the env is unset", () => {
  delete process.env[LOCAL_AUDIO_HOSTS_ENV];
  const providers = selectAudioProviderNodes([CLUSTER_SPEECH_NODE], {
    ...SPEECH_OPTS,
    allowRemote: false,
  });
  assert.equal(providers.length, 0);
});

test("buildDynamicAudioProvider: allowlisted host needs no credential but keeps bearer", () => {
  process.env[LOCAL_AUDIO_HOSTS_ENV] = LIVE_VALUE;
  const allowlisted = buildDynamicAudioProvider(CLUSTER_SPEECH_NODE, "/audio/speech");
  assert.equal(allowlisted.credentialsOptional, true);
  assert.equal(allowlisted.authType, "apikey");
  assert.equal(allowlisted.authHeader, "bearer");
  assert.equal(allowlisted.credentialProviderId, CLUSTER_SPEECH_NODE.id);

  const remote = buildDynamicAudioProvider(REMOTE_SPEECH_NODE, "/audio/speech");
  assert.equal(remote.credentialsOptional, undefined);
  assert.equal(remote.authType, "apikey");

  const loopback = buildDynamicAudioProvider(LOOPBACK_SPEECH_NODE, "/audio/speech");
  assert.equal(loopback.authType, "none");
  assert.equal(loopback.credentialsOptional, undefined);
});
