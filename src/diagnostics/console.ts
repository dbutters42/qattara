// Full console/network/elements panel for on-device debugging, since there's
// no remote inspector without a Mac. Toggled by a small floating button
// eruda adds to the corner; kept out of the way until tapped.

export async function initDeviceConsole(): Promise<void> {
  const eruda = (await import('eruda')).default;
  eruda.init();
}
