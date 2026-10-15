// Ask and Precuts share the same persistent storyboard conversation.
import type { AskAnswer } from "../shared/schema";
import { sidekickSend } from "./sidekick";

export async function ask(root: string, question: string): Promise<AskAnswer> {
  const reply = await sidekickSend(root, question);
  return { text: reply.text, clips: reply.clips ?? [] };
}
