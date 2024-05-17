/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AppsConfig, getModule } from '@scalprum/core';
import ScalprumProvider, {
  ScalprumComponent,
  ScalprumComponentProps,
} from '@scalprum/react-core';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GeneratePayload } from '../common/types';
import { ServiceNames, ServicesEndpoints } from '../integration/endpoints';

declare global {
  interface Window {
    __initialState__: GeneratePayload;
    __endpoints__: Partial<ServicesEndpoints>;
    IS_PRODUCTION: boolean;
  }
}

const state = window.__initialState__;
const config: AppsConfig = {
  [state.scope]: {
    name: state.scope,
    manifestLocation: state.manifestLocation,
  },
};

type CreateAxiosRequest = (
  service: ServiceNames,
  config: AxiosRequestConfig
) => Promise<unknown>;

function createAxiosRequest(service: ServiceNames, config: AxiosRequestConfig) {
  if (window.IS_PRODUCTION && !window.__endpoints__[service]) {
    const message = `Service ${service} not found! Available services: ${Object.keys(
      window.__endpoints__
    ).join(', ')}.\n You might need to add service integration in the config.`;
    console.error(message);
    throw new Error(message);
  }

  if (!config.url) {
    throw new Error('URL is required');
  }
  config.url = `/internal/${service}${config.url}`;
  console.log(config.url);
  return axios(config)
    .then((response: AxiosResponse) => response.data)
    .catch((error) => {
      console.error(error);
      throw error;
    });
}

type FetchData = (createAsyncRequest: CreateAxiosRequest) => Promise<unknown>;

type AsyncState = {
  loading: boolean;
  error: unknown;
  data: unknown;
};

const MetadataWrapper = () => {
  const [asyncState, setAsyncState] = useState<AsyncState>({
    loading: true,
    error: null,
    data: null,
  });
  async function getFetchMetadata() {
    try {
      const fn = await getModule<FetchData | undefined>(
        state.scope,
        state.module,
        'fetchData'
      );
      if (!fn) {
        setAsyncState({ loading: false, error: null, data: null });
        return;
      }
      const data = await fn(createAxiosRequest);

      setAsyncState({ loading: false, error: null, data });
    } catch (error) {
      setAsyncState({ loading: false, error, data: null });
    }
  }
  useEffect(() => {
    getFetchMetadata();
  }, []);
  const props: ScalprumComponentProps<
    Record<string, any>,
    { asyncData: AsyncState }
  > = {
    asyncData: asyncState,
    scope: state.scope,
    module: state.module,
    importName: state.importName,
  };
  return <ScalprumComponent {...props} />;
};

const App = () => {
  return (
    <div>
      <ScalprumProvider pluginSDKOptions={{}} config={config}>
        <div>
          <h1>Hello World</h1>
        </div>
        <div>
          <pre>{JSON.stringify(window.__initialState__, null, 2)}</pre>
        </div>
        <MetadataWrapper />
      </ScalprumProvider>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

const root = createRoot(rootElement);
root.render(<App />);
