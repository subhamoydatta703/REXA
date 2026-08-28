import type { Ora } from "ora";

let activeSpinner: Ora | undefined;

export function setActiveSpinner(spinner: Ora): void {
    activeSpinner = spinner;
}

export function clearActiveSpinner(spinner?: Ora): void {
    if (!spinner || activeSpinner === spinner) {
        activeSpinner = undefined;
    }
}

export function pauseActiveSpinner(): boolean {
    if (!activeSpinner?.isSpinning) return false;
    activeSpinner.stop();
    return true;
}

export function resumeActiveSpinner(wasSpinning: boolean): void {
    if (wasSpinning && activeSpinner && !activeSpinner.isSpinning) {
        activeSpinner.start();
    }
}
