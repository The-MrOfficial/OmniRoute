export interface TopologyProvider {
  id?: string;
  provider: string;
  name?: string;
  status?: 'active' | 'error' | 'idle';
  aliases?: string[];
  routeId?: string;
}
export interface TopologyRequest {
  id?: string;
  provider?: string;
  model?: string;
  timestamp?: number;
  tokensInput?: number;
  tokensOutput?: number;
  latencyMs?: number;
}
export interface TopologyInput {
  providers?: TopologyProvider[];
  activeRequests?: TopologyRequest[];
  lastProvider?: string;
  errorProvider?: string;
}
export interface WorldProvider extends TopologyProvider {
  id: string;
  name: string;
  jobs: TopologyRequest[];
  live: boolean;
  failed: boolean;
  recent: boolean;
}
export function matchesProvider(provider: TopologyProvider, value?: string): boolean;
export function normalizeTopology(input: TopologyInput): WorldProvider[];
