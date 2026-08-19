export interface ConversationScrollContainer {
  scrollTop: number;
  readonly scrollHeight: number;
}

export function scrollConversationToLatest(
  container: ConversationScrollContainer | null,
): void {
  if (!container) return;
  container.scrollTop = container.scrollHeight;
}
