export const SIDE_TABS = ["conversation", "settings"] as const;

export type SideTab = (typeof SIDE_TABS)[number];

export function tabForKey(current: SideTab, key: string): SideTab | null {
  const currentIndex = SIDE_TABS.indexOf(current);

  if (key === "Home") return SIDE_TABS[0];
  if (key === "End") return SIDE_TABS[1];
  if (key === "ArrowRight") return SIDE_TABS[(currentIndex + 1) % SIDE_TABS.length]!;
  if (key === "ArrowLeft") {
    return SIDE_TABS[(currentIndex - 1 + SIDE_TABS.length) % SIDE_TABS.length]!;
  }

  return null;
}
