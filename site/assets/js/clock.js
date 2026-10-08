// Demo clock: shifts "now" for the whole app so a presentation can jump to the
// lunch rush at any hour. Imported first, it swaps the global Date for a subclass
// whose no-argument constructor and Date.now() add an offset. Explicit dates are
// untouched, so timestamps and parsing behave normally.

const RealDate = Date;
let offset = 0;
try { offset = Number(sessionStorage.getItem('rc.clock') || 0) || 0; } catch {}

class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }
  static now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = ShiftedDate;

export const clock = {
  get offset() { return offset; },
  get active() { return offset !== 0; },
  set(ms) {
    offset = Math.round(ms) || 0;
    try { offset ? sessionStorage.setItem('rc.clock', String(offset)) : sessionStorage.removeItem('rc.clock'); } catch {}
    dispatchEvent(new CustomEvent('rc:clock', { detail: offset }));
  },
  /** Offset that makes campus time (IST) read `hour` today. */
  offsetForCampusHour(hour) {
    const real = RealDate.now();
    const ist = new RealDate(real + 330 * 60000);
    const midnight = RealDate.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60000;
    return midnight + hour * 3600000 - real;
  },
};
