import './test-env';

const noop = () => undefined;
if (!process.env.DREAMER_TEST_VERBOSE_LOGS) {
  console.log = noop;
  console.info = noop;
  console.warn = noop;
}
