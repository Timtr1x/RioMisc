// Idle contest: same download/submit plumbing as Mock, but no built-in fixtures.
// Used when you want to feed real tasks (Dashboard URL / manual inject) without
// 11 demo challenges eating every solver slot.
import { MockContestAdapter } from "./mock.js";

export class IdleContestAdapter extends MockContestAdapter {
  override readonly kind = "idle";
}
