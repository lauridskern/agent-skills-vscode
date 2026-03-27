export type MarketplaceFeed = "all-time" | "trending" | "hot";

export interface MarketplaceSkill {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
  official?: boolean;
  installsYesterday?: number;
  change?: number;
  socketOverall?: number;
  snykRisk?: string;
  geminiVerdict?: string;
  auditTitle?: string;
}

export interface RawMarketplaceSkill {
  id?: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
  installsYesterday?: number;
  change?: number;
  official?: boolean;
  socketOverall?: number;
  snykRisk?: string;
  geminiVerdict?: string;
  auditTitle?: string;
}

export interface MarketplaceFeedResponse<TSkill = RawMarketplaceSkill> {
  skills: TSkill[];
  total: number;
  hasMore: boolean;
  page: number;
}

export interface SkillsSearchResponse {
  query: string;
  searchType: string;
  skills: MarketplaceSkill[];
  count: number;
  duration_ms: number;
}
