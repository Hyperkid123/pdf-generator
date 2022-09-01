import axios, { AxiosRequestHeaders, AxiosRequestConfig } from 'axios';
import ServiceNames from './service-names';
import config from '../config';

const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';
// TODO: Base it on https://gitlab.cee.redhat.com/service/app-interface/-/blob/master/data/products/insights/environments/production.yml and load trough clowder

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
  if (!serviceConfig) {
    throw new Error(`Trying to reach unusupported service ${service}!`);
  }
  const URL = `${serviceConfig.hostname}:${serviceConfig.port}${path}`;
  return async (headers, options) => {
    let data;
    if (IS_DEVELOPMENT) {
      data = descriptor.mock();
    } else {
      data = await axios({ ...options, url: URL, headers });
    }
    return responseProcessor(data);
  };
}

export default prepareServiceCall;
