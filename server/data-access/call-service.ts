import axios, { AxiosRequestHeaders, AxiosRequestConfig } from 'axios';
import ServiceNames from './service-names';
import config from '../config';

const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';

export type APIDescriptor<T = Record<string, unknown>, R = unknown> = {
  service: ServiceNames;
  path: string;
  responseProcessor: (...args: any[]) => R;
  mock: (...args: any[]) => Promise<T>;
};

export type ServiceCallFunction = (
  headers: AxiosRequestHeaders,
  options: Omit<AxiosRequestConfig, 'headers'>
) => Promise<unknown>;

function prepareServiceCall<T = Record<string, unknown>>(
  descriptor: APIDescriptor<T>
): ServiceCallFunction {
  const { service, path, responseProcessor } = descriptor;
  const serviceConfig = config.endpoints[service];
  if (!IS_DEVELOPMENT && !serviceConfig) {
    return () =>
      Promise.reject(`Trying to reach unusupported service ${service}!`);
  }
  const URL = `${serviceConfig?.hostname}:${serviceConfig?.port}${path}`;
  console.log(
    'Prepared service call for: ',
    service,
    ', at:',
    URL,
    config.endpoints
  );
  return async (headers, options) => {
    let data;
    if (IS_DEVELOPMENT) {
      data = descriptor.mock();
    } else {
      try {
        data = await axios({ ...options, url: URL, headers });
      } catch (error) {
        console.log('Unable to get report data: ', error);
        return Promise.reject(error);
      }
    }
    return responseProcessor(data);
  };
}

export default prepareServiceCall;
