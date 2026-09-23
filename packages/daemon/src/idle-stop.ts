/**
 * Stop the daemon after it has had zero clients for idleStopMs.
 * A new connection cancels the timer. idleStopMs 0 disables the timer.
 * The HTTP gateway, when enabled, counts as always busy so a published
 * gateway is not torn down between browser requests.
 */
export interface IdleStop {
  onConnect(): void;
  onDisconnect(): void;
  arm(): void;
  stop(): void;
}

export function createIdleStop(opts: {
  idleStopMs: number;
  isBusy: () => boolean;
  onIdle: () => void;
}): IdleStop {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = () => {
    if (!opts.idleStopMs || opts.isBusy()) {
      clear();
      return;
    }
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (opts.isBusy()) return;
      opts.onIdle();
    }, opts.idleStopMs);
    timer.unref?.();
  };

  return {
    onConnect() {
      clear();
    },
    onDisconnect() {
      arm();
    },
    arm,
    stop: clear,
  };
}
