/**
 * Poll until `find` returns something truthy.
 *
 * For writes the code makes fire-and-forget (audit entries, usage counts).
 * A fixed sleep before reading them passes on a quiet machine and fails when
 * the suite runs alongside anything else; polling waits as long as the write
 * takes and no longer.
 *
 * @param {Function} find async; returns the thing waited for, or a falsy value
 * @param {number} [timeout=3000] give up and return the last result after this
 */
async function eventually(find, timeout = 3000) {
  const until = Date.now() + timeout;
  let found = await find();
  while (!found && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 25));
    found = await find();
  }
  return found;
}

module.exports = eventually;
