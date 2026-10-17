/** Persist visited companies in opening order without cancelling a request just
 * because the user navigates to a different route before it settles. */
export function enqueueCompanyActivation(
  queue: { current: Promise<void> },
  activate: () => Promise<void>,
): Promise<void> {
  const next = queue.current.catch(() => {}).then(activate);
  queue.current = next;
  return next;
}
