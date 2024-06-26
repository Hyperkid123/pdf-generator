import { Cluster } from 'puppeteer-cluster';
import config from '../common/config';
// Match the timeout on the gateway
const BROWSER_TIMEOUT = 60_000;
import { CHROMIUM_PATH } from '../browser/helpers';

export const GetPupCluster = async () => {
  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: 1,
    puppeteerOptions: {
      timeout: BROWSER_TIMEOUT,
      ...(config?.IS_PRODUCTION
        ? {
            // we have a different dir structure than puppeteer expects. We have to point it to the correct chromium executable
            executablePath: CHROMIUM_PATH,
          }
        : {}),
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--no-zygote',
        '--no-first-run',
        '--disable-dev-shm-usage',
        // '--single-process',
        '--mute-audio',
        "--proxy-server='direct://'",
        '--proxy-bypass-list=*',
      ],
    },
  });
  return cluster;
};

export const cluster = await GetPupCluster();
