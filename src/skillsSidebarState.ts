import { Skill } from "./types";
import { MarketplaceSkill } from "./skillsMarketplaceTypes";

export interface WebviewState {
  installedSkills: Skill[];
  marketplaceSkills: MarketplaceSkill[];
  isLoadingMarketplace: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  marketplaceError: string | null;
  searchQuery: string;
  activePanel: "installed" | "marketplace";
  scroll: {
    installed: number;
    marketplace: number;
  };
}
