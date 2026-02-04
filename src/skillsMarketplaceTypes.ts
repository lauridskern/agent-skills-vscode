export interface MarketplaceSkill {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

export interface SkillsApiResponse {
  skills: MarketplaceSkill[];
  hasMore: boolean;
}
