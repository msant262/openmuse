import type { RuntimePauseState } from "../../../../packages/domain/src/runtime.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

const initialPause: RuntimePauseState = {
  paused: false,
  revision: 0,
  changedAt: "1970-01-01T00:00:00.000Z",
};

export class RuntimePausedError extends AppError {
  constructor(readonly pause: RuntimePauseState) {
    super(
      "Automations are globally paused. Resume them explicitly before dispatching new work.",
      409,
    );
    this.name = "RuntimePausedError";
  }
}

export class RuntimePause {
  constructor(
    private readonly db: Store,
    private readonly now: () => number = Date.now,
  ) {}

  async get(_owner: string): Promise<RuntimePauseState> {
    return (await this.db.getRuntimePause()) ?? initialPause;
  }

  async set(
    _owner: string,
    input: { paused: boolean; expectedRevision: number },
  ): Promise<RuntimePauseState> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)
      throw new AppError("Pause revision must be a nonnegative integer", 422);
    const state = await this.db.setRuntimePause(
      input.paused,
      input.expectedRevision,
      new Date(this.now()).toISOString(),
    );
    if (!state) throw new AppError("Pause state changed; refresh and try again", 409);
    return state;
  }

  async assertResumed(owner: string): Promise<RuntimePauseState> {
    const state = await this.get(owner);
    if (state.paused) throw new RuntimePausedError(state);
    return state;
  }
}
