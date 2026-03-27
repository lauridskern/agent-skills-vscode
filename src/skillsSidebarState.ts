import { Skill } from "./types";
import { MarketplaceFeed, MarketplaceSkill } from "./skillsMarketplaceTypes";

export interface WebviewState {
  installedSkills: Skill[];
  marketplaceSkills: MarketplaceSkill[];
  isLoadingMarketplace: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  marketplaceError: string | null;
  searchQuery: string;
  activePanel: "installed" | "marketplace";
  activeMarketplaceFeed: MarketplaceFeed;
  scroll: {
    installed: number;
    marketplace: number;
  };
}
