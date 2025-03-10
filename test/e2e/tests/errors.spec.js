const { resolve } = require('path');
const { promises: fs } = require('fs');
const { strict: assert } = require('assert');
const { get, has, set } = require('lodash');
const { Browser } = require('selenium-webdriver');
const { format } = require('prettier');
const { convertToHexValue, withFixtures } = require('../helpers');
const FixtureBuilder = require('../fixture-builder');

const dateFields = ['metamask.conversionDate'];

/**
 * Transform date properties to value types, to ensure that state is
 * consistent between test runs.
 *
 * @param {unknown} data - The data to transform
 */
function transformDates(data) {
  for (const field of dateFields) {
    if (has(data, field)) {
      set(data, field, typeof get(data, field));
    }
  }
  return data;
}

/**
 * Check that the data provided matches the snapshot.
 *
 * @param {object }args - Function arguments.
 * @param {any} args.data - The data to compare with the snapshot.
 * @param {string} args.snapshot - The name of the snapshot.
 * @param {boolean} [args.update] - Whether to update the snapshot if it doesn't match.
 */
async function matchesSnapshot({
  data: unprocessedData,
  snapshot,
  update = process.env.UPDATE_SNAPSHOTS === 'true',
}) {
  const data = transformDates(unprocessedData);

  const snapshotPath = resolve(__dirname, `./state-snapshots/${snapshot}.json`);
  const rawSnapshotData = await fs.readFile(snapshotPath, {
    encoding: 'utf-8',
  });
  const snapshotData = JSON.parse(rawSnapshotData);

  try {
    assert.deepStrictEqual(data, snapshotData);
  } catch (error) {
    if (update && error instanceof assert.AssertionError) {
      const stringifiedData = JSON.stringify(data);
      // filepath specified so that Prettier can infer which parser to use
      // from the file extension
      const formattedData = format(stringifiedData, {
        filepath: 'something.json',
      });
      await fs.writeFile(snapshotPath, formattedData, {
        encoding: 'utf-8',
      });
      console.log(`Snapshot '${snapshot}' updated`);
      return;
    }
    throw error;
  }
}

describe('Sentry errors', function () {
  const migrationError =
    process.env.SELENIUM_BROWSER === Browser.CHROME
      ? `Cannot read properties of undefined (reading 'version')`
      : 'meta is undefined';
  async function mockSentryMigratorError(mockServer) {
    return await mockServer
      .forPost('https://sentry.io/api/0000000/envelope/')
      .withBodyIncluding(migrationError)
      .thenCallback(() => {
        return {
          statusCode: 200,
          json: {},
        };
      });
  }

  async function mockSentryTestError(mockServer) {
    return await mockServer
      .forPost('https://sentry.io/api/0000000/envelope/')
      .withBodyIncluding('Test Error')
      .thenCallback(() => {
        return {
          statusCode: 200,
          json: {},
        };
      });
  }
  const ganacheOptions = {
    accounts: [
      {
        secretKey:
          '0x7C9529A67102755B7E6102D6D950AC5D5863C98713805CEC576B945B15B71EAC',
        balance: convertToHexValue(25000000000000000000),
      },
    ],
  };

  describe('before initialization, after opting out of metrics', function () {
    it('should NOT send error events in the background', async function () {
      await withFixtures(
        {
          fixtures: {
            ...new FixtureBuilder()
              .withMetaMetricsController({
                metaMetricsId: null,
                participateInMetaMetrics: false,
              })
              .build(),
            // Intentionally corrupt state to trigger migration error during initialization
            meta: undefined,
          },
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryMigratorError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();

          // Wait for Sentry request
          await driver.delay(3000);
          const isPending = await mockedEndpoint.isPending();
          assert.ok(
            isPending,
            'A request to sentry was sent when it should not have been',
          );
        },
      );
    });

    it('should NOT send error events in the UI', async function () {
      await withFixtures(
        {
          fixtures: new FixtureBuilder()
            .withMetaMetricsController({
              metaMetricsId: null,
              participateInMetaMetrics: false,
            })
            .build(),
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryTestError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();
          await driver.findElement('#password');
          // Erase `getSentryState` hook, simulating a "before initialization" state
          await driver.executeScript(
            'window.stateHooks.getSentryState = undefined',
          );

          // Wait for Sentry request
          await driver.delay(3000);
          const isPending = await mockedEndpoint.isPending();
          assert.ok(
            isPending,
            'A request to sentry was sent when it should not have been',
          );
        },
      );
    });
  });

  describe('before initialization, after opting into metrics', function () {
    it('should send error events in background', async function () {
      await withFixtures(
        {
          fixtures: {
            ...new FixtureBuilder()
              .withMetaMetricsController({
                metaMetricsId: 'fake-metrics-id',
                participateInMetaMetrics: true,
              })
              .build(),
            // Intentionally corrupt state to trigger migration error during initialization
            meta: undefined,
          },
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryMigratorError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();

          // Wait for Sentry request
          await driver.wait(async () => {
            const isPending = await mockedEndpoint.isPending();
            return isPending === false;
          }, 3000);

          const [mockedRequest] = await mockedEndpoint.getSeenRequests();
          const mockTextBody = mockedRequest.body.text.split('\n');
          const mockJsonBody = JSON.parse(mockTextBody[2]);
          const { level } = mockJsonBody;
          const [{ type, value }] = mockJsonBody.exception.values;
          // Verify request
          assert.equal(type, 'TypeError');
          assert(value.includes(migrationError));
          assert.equal(level, 'error');
        },
      );
    });

    it('should capture background application state', async function () {
      await withFixtures(
        {
          fixtures: {
            ...new FixtureBuilder()
              .withMetaMetricsController({
                metaMetricsId: 'fake-metrics-id',
                participateInMetaMetrics: true,
              })
              .build(),
            // Intentionally corrupt state to trigger migration error during initialization
            meta: undefined,
          },
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryMigratorError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();

          // Wait for Sentry request
          await driver.wait(async () => {
            const isPending = await mockedEndpoint.isPending();
            return isPending === false;
          }, 3000);

          const [mockedRequest] = await mockedEndpoint.getSeenRequests();
          const mockTextBody = mockedRequest.body.text.split('\n');
          const mockJsonBody = JSON.parse(mockTextBody[2]);
          const appState = mockJsonBody?.extra?.appState;
          await matchesSnapshot({
            data: appState,
            snapshot: 'errors-before-init-opt-in-background-state',
          });
        },
      );
    });

    it('should send error events in UI', async function () {
      await withFixtures(
        {
          fixtures: new FixtureBuilder()
            .withMetaMetricsController({
              metaMetricsId: 'fake-metrics-id',
              participateInMetaMetrics: true,
            })
            .build(),
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryTestError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();
          await driver.findElement('#password');
          // Erase `getSentryState` hook, simulating a "before initialization" state
          await driver.executeScript(
            'window.stateHooks.getSentryState = undefined',
          );

          // Trigger error
          await driver.executeScript('window.stateHooks.throwTestError()');

          // Wait for Sentry request
          await driver.wait(async () => {
            const isPending = await mockedEndpoint.isPending();
            return isPending === false;
          }, 3000);
          const [mockedRequest] = await mockedEndpoint.getSeenRequests();
          const mockTextBody = mockedRequest.body.text.split('\n');
          const mockJsonBody = JSON.parse(mockTextBody[2]);
          const { level } = mockJsonBody;
          const [{ type, value }] = mockJsonBody.exception.values;
          // Verify request
          assert.equal(type, 'TestError');
          assert.equal(value, 'Test Error');
          assert.equal(level, 'error');
        },
      );
    });

    it('should capture UI application state', async function () {
      await withFixtures(
        {
          fixtures: new FixtureBuilder()
            .withMetaMetricsController({
              metaMetricsId: 'fake-metrics-id',
              participateInMetaMetrics: true,
            })
            .build(),
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryTestError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();
          await driver.findElement('#password');
          // Erase `getSentryState` hook, simulating a "before initialization" state
          await driver.executeScript(
            'window.stateHooks.getSentryState = undefined',
          );

          // Trigger error
          await driver.executeScript('window.stateHooks.throwTestError()');

          // Wait for Sentry request
          await driver.wait(async () => {
            const isPending = await mockedEndpoint.isPending();
            return isPending === false;
          }, 3000);
          const [mockedRequest] = await mockedEndpoint.getSeenRequests();
          const mockTextBody = mockedRequest.body.text.split('\n');
          const mockJsonBody = JSON.parse(mockTextBody[2]);
          const appState = mockJsonBody?.extra?.appState;
          await matchesSnapshot({
            data: appState,
            snapshot: 'errors-before-init-opt-in-ui-state',
          });
        },
      );
    });
  });

  describe('after initialization, after opting out of metrics', function () {
    it('should NOT send error events in the background', async function () {
      await withFixtures(
        {
          fixtures: new FixtureBuilder()
            .withMetaMetricsController({
              metaMetricsId: null,
              participateInMetaMetrics: false,
            })
            .build(),
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryTestError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();
          await driver.findElement('#password');

          // Trigger error
          await driver.executeScript(
            'window.stateHooks.throwTestBackgroundError()',
          );

          // Wait for Sentry request
          const isPending = await mockedEndpoint.isPending();
          assert.ok(
            isPending,
            'A request to sentry was sent when it should not have been',
          );
        },
      );
    });

    it('should NOT send error events in the UI', async function () {
      await withFixtures(
        {
          fixtures: new FixtureBuilder()
            .withMetaMetricsController({
              metaMetricsId: null,
              participateInMetaMetrics: false,
            })
            .build(),
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryTestError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();
          await driver.findElement('#password');

          // Trigger error
          await driver.executeScript('window.stateHooks.throwTestError()');

          // Wait for Sentry request
          const isPending = await mockedEndpoint.isPending();
          assert.ok(
            isPending,
            'A request to sentry was sent when it should not have been',
          );
        },
      );
    });
  });

  describe('after initialization, after opting into metrics', function () {
    it('should send error events in background', async function () {
      await withFixtures(
        {
          fixtures: new FixtureBuilder()
            .withMetaMetricsController({
              metaMetricsId: 'fake-metrics-id',
              participateInMetaMetrics: true,
            })
            .build(),
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryTestError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();
          await driver.findElement('#password');

          // Trigger error
          await driver.executeScript(
            'window.stateHooks.throwTestBackgroundError()',
          );

          // Wait for Sentry request
          await driver.wait(async () => {
            const isPending = await mockedEndpoint.isPending();
            return isPending === false;
          }, 3000);
          const [mockedRequest] = await mockedEndpoint.getSeenRequests();
          const mockTextBody = mockedRequest.body.text.split('\n');
          const mockJsonBody = JSON.parse(mockTextBody[2]);
          const { level, extra } = mockJsonBody;
          const [{ type, value }] = mockJsonBody.exception.values;
          const { participateInMetaMetrics } = extra.appState.store.metamask;
          // Verify request
          assert.equal(type, 'TestError');
          assert.equal(value, 'Test Error');
          assert.equal(level, 'error');
          assert.equal(participateInMetaMetrics, true);
        },
      );
    });

    it('should capture background application state', async function () {
      await withFixtures(
        {
          fixtures: new FixtureBuilder()
            .withMetaMetricsController({
              metaMetricsId: 'fake-metrics-id',
              participateInMetaMetrics: true,
            })
            .build(),
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryTestError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();
          await driver.findElement('#password');

          // Trigger error
          await driver.executeScript(
            'window.stateHooks.throwTestBackgroundError()',
          );

          // Wait for Sentry request
          await driver.wait(async () => {
            const isPending = await mockedEndpoint.isPending();
            return isPending === false;
          }, 3000);
          const [mockedRequest] = await mockedEndpoint.getSeenRequests();
          const mockTextBody = mockedRequest.body.text.split('\n');
          const mockJsonBody = JSON.parse(mockTextBody[2]);
          const appState = mockJsonBody?.extra?.appState;
          assert.deepStrictEqual(Object.keys(appState), [
            'browser',
            'store',
            'version',
          ]);
          assert.ok(
            typeof appState?.browser === 'string' &&
              appState?.browser.length > 0,
            'Invalid browser state',
          );
          assert.ok(
            typeof appState?.version === 'string' &&
              appState?.version.length > 0,
            'Invalid version state',
          );
          await matchesSnapshot({
            data: appState.store,
            snapshot: 'errors-after-init-opt-in-background-state',
          });
        },
      );
    });

    it('should send error events in UI', async function () {
      await withFixtures(
        {
          fixtures: new FixtureBuilder()
            .withMetaMetricsController({
              metaMetricsId: 'fake-metrics-id',
              participateInMetaMetrics: true,
            })
            .build(),
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryTestError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();
          await driver.findElement('#password');

          // Trigger error
          await driver.executeScript('window.stateHooks.throwTestError()');

          // Wait for Sentry request
          await driver.wait(async () => {
            const isPending = await mockedEndpoint.isPending();
            return isPending === false;
          }, 3000);
          const [mockedRequest] = await mockedEndpoint.getSeenRequests();
          const mockTextBody = mockedRequest.body.text.split('\n');
          const mockJsonBody = JSON.parse(mockTextBody[2]);
          const { level, extra } = mockJsonBody;
          const [{ type, value }] = mockJsonBody.exception.values;
          const { participateInMetaMetrics } = extra.appState.store.metamask;
          // Verify request
          assert.equal(type, 'TestError');
          assert.equal(value, 'Test Error');
          assert.equal(level, 'error');
          assert.equal(participateInMetaMetrics, true);
        },
      );
    });

    it('should capture UI application state', async function () {
      await withFixtures(
        {
          fixtures: new FixtureBuilder()
            .withMetaMetricsController({
              metaMetricsId: 'fake-metrics-id',
              participateInMetaMetrics: true,
            })
            .build(),
          ganacheOptions,
          title: this.test.title,
          failOnConsoleError: false,
          testSpecificMock: mockSentryTestError,
        },
        async ({ driver, mockedEndpoint }) => {
          await driver.navigate();
          await driver.findElement('#password');

          // Trigger error
          await driver.executeScript('window.stateHooks.throwTestError()');

          // Wait for Sentry request
          await driver.wait(async () => {
            const isPending = await mockedEndpoint.isPending();
            return isPending === false;
          }, 3000);
          const [mockedRequest] = await mockedEndpoint.getSeenRequests();
          const mockTextBody = mockedRequest.body.text.split('\n');
          const mockJsonBody = JSON.parse(mockTextBody[2]);
          const appState = mockJsonBody?.extra?.appState;
          assert.deepStrictEqual(Object.keys(appState), [
            'browser',
            'store',
            'version',
          ]);
          assert.ok(
            typeof appState?.browser === 'string' &&
              appState?.browser.length > 0,
            'Invalid browser state',
          );
          assert.ok(
            typeof appState?.version === 'string' &&
              appState?.version.length > 0,
            'Invalid version state',
          );
          await matchesSnapshot({
            data: appState.store,
            snapshot: 'errors-after-init-opt-in-ui-state',
          });
        },
      );
    });
  });
});
