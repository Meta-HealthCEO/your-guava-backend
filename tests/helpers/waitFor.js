/**
 * Poll until probe() returns something truthy, or fail with a named timeout. Deadline-based, not
 * count-based, so a loaded CI runner gets the same wall-clock budget as a fast laptop.
 */
const waitFor = async (probe, { timeoutMs = 5000, intervalMs = 5, message = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

module.exports = { waitFor };
