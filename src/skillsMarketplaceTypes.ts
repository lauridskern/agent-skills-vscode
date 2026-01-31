export interface MarketplaceSkill {
  id: string;
  name: string;
  installs: number;
  topSource: string;
}

export interface SkillsApiResponse {
  skills: MarketplaceSkill[];
  hasMore: boolean;
}
