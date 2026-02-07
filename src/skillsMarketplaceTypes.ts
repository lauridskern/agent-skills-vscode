export interface MarketplaceSkill {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

export interface RawAllTimeSkill {
  id?: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

export interface SkillsSearchResponse {
  query: string;
  searchType: string;
  skills: MarketplaceSkill[];
  count: number;
  duration_ms: number;
}
