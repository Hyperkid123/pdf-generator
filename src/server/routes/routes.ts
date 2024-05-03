import fs from 'fs';
import { Router } from 'express';
import httpContext from 'express-http-context';
import getTemplateData from '../data-access';
import ServiceNames from '../../common/service-names';
import renderTemplate from '../render-template';
import {
  processOrientationOption,
  sanitizeFilepath,
  sanitizeTemplateConfig,
} from '../../browser/helpers';
import PdfCache from '../../common/pdfCache';
import {
  SendingFailedError,
  PDFNotFoundError,
  PdfGenerationError,
} from '../errors';
import config from '../../common/config';
import previewPdf from '../../browser/previewPDF';
import pool from '../workers';
import { Request } from 'express';
import {
  GenerateHandlerRequest,
  PdfRequestBody,
  PuppeteerBrowserRequest,
  PreviewHandlerRequest,
} from '../../common/types';
import { apiLogger } from '../../common/logging';
import { v4 as uuidv4 } from 'uuid';
import { ReportCache } from '../cache';
import { downloadPDF } from '../../common/objectStore';
import { Readable } from 'stream';
import { UpdateStatus, sanitizeRecord } from '../utils';
import { cluster } from '../cluster';
import { generatePdf } from '../../browser/clusterTask';
import { API_CALL_LIMIT } from '../../browser/constants';
import { isRosSystemsData } from '../data-access/rosDescriptor/rosData';

const CALL_LIMIT = Number(process.env.API_CALL_LIMIT) || API_CALL_LIMIT;

const router = Router();
const cache = new ReportCache();
const pdfCache = PdfCache.getInstance();

function getPdfRequestBody(req: GenerateHandlerRequest): PdfRequestBody {
  const rhIdentity = httpContext.get(config?.IDENTITY_HEADER_KEY);
  const orientationOption = processOrientationOption(req);
  const service = req.body.service;
  const template = req.body.template;
  const dataOptions = req.body;
  const uuid = `${uuidv4()}`;
  const url = `http://localhost:${config?.webPort}?template=${template}&service=${service}`;
  return {
    url,
    rhIdentity,
    templateConfig: {
      service,
      template,
    },
    orientationOption,
    dataOptions,
    uuid,
  };
}

const isValidPdfRequest = (body: PdfRequestBody) => {
  // identity is handled at the worker level
  if (
    body.templateConfig.template === '' ||
    !Object.values(ServiceNames).includes(body.templateConfig.service)
  ) {
    return false;
  }
  return true;
};

// Middleware that activates on all routes, responsible for rendering the correct
// template/component into html to the requester.
router.use('^/$', async (req: PuppeteerBrowserRequest, res, _next) => {
  let service: ServiceNames = req.query.service;
  let template: string = req.query.template;
  if (!service) {
    apiLogger.warning('Missing service, using "demo"');
    service = ServiceNames.demo;
  }
  if (!template) {
    apiLogger.warning('Missing template, using "demo"');
    template = 'demo';
  }

  const templateConfig = {
    service,
    template,
  };
  try {
    const configHeaders: string | string[] | undefined =
      req.headers[config?.OPTIONS_HEADER_NAME];
    if (configHeaders) {
      delete req.headers[config?.OPTIONS_HEADER_NAME];
    }

    const templateData = await getTemplateData(
      req.headers,
      templateConfig,
      configHeaders ? JSON.parse(configHeaders as string) : undefined
    );

    const start = req.headers['start'];
    const end = req.headers['end'];
    if (
      start !== 'undefined' &&
      end !== 'undefined' &&
      start !== undefined &&
      end !== undefined
    ) {
      apiLogger.debug(
        `Processing data range ${req.headers['start']}::${req.headers['end']}`
      );
      const clone = JSON.parse(JSON.stringify(templateData));
      const castData = clone as Record<string, any>;
      const slicedData = castData.data.data.slice(start, end);
      castData.data.data = slicedData;
      const HTMLTemplate: string = renderTemplate(
        sanitizeTemplateConfig(templateConfig),
        sanitizeRecord(castData)
      );
      res.send(HTMLTemplate);
      return;
    }

    const HTMLTemplate: string = renderTemplate(
      sanitizeTemplateConfig(templateConfig),
      sanitizeRecord(templateData as Record<string, unknown>)
    );
    res.send(HTMLTemplate);
  } catch (error) {
    // render error to DOM to retrieve the error content from puppeteer
    res.send(
      `<div id="report-error" data-error="${JSON.stringify(
        error
      )}">${error}</div>`
    );
  }
});

router.get(`${config?.APIPrefix}/v1/hello`, (_req, res) => {
  return res.status(200).send('<h1>Well this works!</h1>');
});

type RenderData = {
  totalItems: number;
  calls: number;
  renderableData: any;
};

// TODO: This is not and will be fixed when federated magic is applied
const processTemplateRequest = (templateData: any) => {
  const renderData: RenderData = <RenderData>{};
  switch (true) {
    case isRosSystemsData(templateData.data) == true: {
      const baseData = templateData.data.data;
      if (Array.isArray(baseData)) {
        renderData.totalItems = baseData.length;
        renderData.calls = Math.ceil(renderData.totalItems / CALL_LIMIT);
        renderData.renderableData = baseData;
      }
      return renderData;
    }
    default:
      apiLogger.debug('no matching data for template');
      break;
  }
};

router.post(
  `${config?.APIPrefix}/v2/create`,
  async (req: GenerateHandlerRequest, res, next) => {
    // need to support multiple IDs in a group
    // and await the results to combine
    const pdfDetails = getPdfRequestBody(req);
    const collectionId = pdfDetails.uuid;
    if (!isValidPdfRequest(pdfDetails)) {
      const errStr = 'Failed: service and template options must not be empty';
      apiLogger.debug(errStr);
      return res.status(400).send({
        error: {
          status: 400,
          statusText: 'Bad Request',
          description: `${errStr}`,
        },
      });
    }
    const configHeaders: string | string[] | undefined =
      req.headers[config?.OPTIONS_HEADER_NAME];
    if (configHeaders) {
      delete req.headers[config?.OPTIONS_HEADER_NAME];
    }

    const templateRequest = await getTemplateData(
      req.headers,
      pdfDetails.templateConfig,
      configHeaders ? JSON.parse(configHeaders as string) : undefined
    );
    const renderData = processTemplateRequest(templateRequest);

    try {
      const requiredCalls = renderData?.calls;
      if (requiredCalls === 1) {
        const id = `${uuidv4()}`;
        apiLogger.debug(`Single call to generator queued for ${collectionId}`);
        await generatePdf(pdfDetails, {}, id);
        const updateMessage = {
          status: 'Generating',
          filepath: '',
          componentId: id,
          collectionId: collectionId,
        };
        UpdateStatus(updateMessage);
        return res.status(202).send({ statusID: collectionId });
      }
      // add these in a loop
      apiLogger.debug(`Queueing ${requiredCalls} for ${collectionId}`);
      for (let x = 0; x < Number(requiredCalls); x++) {
        const segmentStart = x * CALL_LIMIT;
        const segmentEnd = segmentStart + CALL_LIMIT - 1;
        const dataRange = { start: segmentStart, end: segmentEnd };

        const id = `${uuidv4()}`;
        await generatePdf(pdfDetails, dataRange, id);
        const updateMessage = {
          status: 'Generating',
          filepath: '',
          componentId: id,
          collectionId: collectionId,
        };
        UpdateStatus(updateMessage);
      }

      return res.status(202).send({ statusID: collectionId });
    } catch (error: unknown) {
      if (error instanceof PdfGenerationError) {
        if (error.message.includes('No API descriptor')) {
          const updateMessage = {
            status: `Failed: ${error.message}`,
            filepath: '',
            collectionId: error.collectionId,
            componentId: error.componentId,
          };
          apiLogger.error(`Error: ${error}`);
          UpdateStatus(updateMessage);
          res.status(400).send({
            error: {
              status: 400,
              statusText: 'Bad Request',
              description: `${error}`,
            },
          });
        } else {
          apiLogger.error(`Internal Server error: ${error}`);
          const updateMessage = {
            status: `Failed: ${error}`,
            filepath: '',
            collectionId: error.collectionId,
            componentId: error.componentId,
          };
          UpdateStatus(updateMessage);
          res.status(500).send({
            error: {
              status: 500,
              statusText: 'Internal server error',
              description: `${error}`,
            },
          });
        }
      }
      next();
    } finally {
      // To handle the edge case where a pool terminates while the queue isn't empty,
      // we ensure that the queue is empty and all workers are idle.
      await cluster.idle();
      apiLogger.debug('task finished');
      await cluster.close();
    }
  }
);

router.get(`${config?.APIPrefix}/v2/status/:statusID`, (req: Request, res) => {
  const ID = req.params.statusID;
  try {
    const status = pdfCache.getCollection(ID);
    apiLogger.debug(JSON.stringify(status));
    if (!status) {
      res.status(404).send({
        error: {
          status: 404,
          statusText: 'PDF status could not be determined; Please check the ID',
          description: `No PDF status found for ${ID}`,
        },
      });
    }

    return res.status(200).send({ status });
  } catch (error) {
    res.status(400).send({
      error: {
        status: 400,
        statusText: 'PDF status could not be determined',
        description: `Error: ${error}`,
      },
    });
  }
});

router.get(
  `${config?.APIPrefix}/v2/download/:ID`,
  async (req: Request, res) => {
    const ID = req.params.ID;
    try {
      apiLogger.debug(ID);
      const response = await downloadPDF(ID);
      if (!response) {
        return res.status(404).send({
          error: {
            status: 404,
            statusText: `No PDF found; Please check the status of this ID`,
            description: `No PDF found for ${ID}`,
          },
        });
      }
      if (response.ContentLength && response.ContentLength > 0) {
        const contentLength = response.ContentLength;
        res.setHeader('Content-Length', contentLength);
      }
      res.setHeader('Content-Disposition', `inline; filename="${ID}.pdf"`);
      res.setHeader('Content-Type', 'application/pdf');
      const stream = response.Body as Readable;
      stream.pipe(res);
    } catch (error) {
      res.status(400).send({
        error: {
          status: 400,
          statusText: 'PDF status could not be determined',
          description: `Error: ${error}`,
        },
      });
    }
  }
);

router.post(
  `${config?.APIPrefix}/v1/generate`,
  async (req: GenerateHandlerRequest, res, next) => {
    const pdfDetails = getPdfRequestBody(req);
    const { rhIdentity: _, ...noIdentityHeader } = pdfDetails;
    const accountID = httpContext.get(config?.ACCOUNT_ID);
    const ID = pdfDetails.uuid;
    const cacheKey = cache.createCacheKey({
      request: noIdentityHeader,
      accountID: accountID,
    });
    apiLogger.debug(`Hashed key ${cacheKey} with Account ID ${accountID}`);

    // Check for a cached version of the pdf
    const filePath = cache.fetch(sanitizeFilepath(cacheKey));
    if (filePath) {
      apiLogger.info(`No new generation needed ${filePath} found in cache.`);
      return res.status(200).sendFile(sanitizeFilepath(filePath), (err) => {
        if (err) {
          const errorMessage = new SendingFailedError(filePath, err);
          res.status(500).send({
            error: {
              status: 500,
              statusText: 'PDF was generated, but could not be sent',
              description: `${errorMessage}`,
            },
          });
        }
      });
    }

    apiLogger.debug(JSON.stringify(pool.stats(), null, 2));

    try {
      const pathToPdf = await pool.exec<(...args: unknown[]) => string>(
        'generatePdf',
        [pdfDetails]
      );

      const pdfFileName = pathToPdf.split('/').pop();

      if (!fs.existsSync(pathToPdf)) {
        throw new PDFNotFoundError(pdfFileName as string);
      }
      cache.fill(cacheKey, pathToPdf);
      res.setHeader('Content-Disposition', `inline; filename="${ID}.pdf"`);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Deprecated', 'True');
      const sanitizedPath = sanitizeFilepath(pathToPdf);
      return res.status(200).sendFile(sanitizedPath, (err) => {
        if (err) {
          const errorMessage = new SendingFailedError(
            pdfFileName as string,
            err
          );
          res.status(500).send({
            error: {
              status: 500,
              statusText: 'PDF was generated, but could not be sent',
              description: `${errorMessage}`,
            },
          });
        }
        apiLogger.info('Successfully generated report');
      });
    } catch (error: unknown) {
      const errStr = `${error}`;
      if (errStr.includes('No API descriptor')) {
        apiLogger.error(`Failed to generate a PDF: ${error}`);
        res.status(400).send({
          error: {
            status: 400,
            statusText: 'Bad Request',
            description: `${error}`,
          },
        });
      } else {
        apiLogger.error(`Internal Server error: ${error}`);
        res.status(500).send({
          error: {
            status: 500,
            statusText: 'Internal server error',
            description: `${error}`,
          },
        });
      }
      next();
    } finally {
      // To handle the edge case where a pool terminates while the queue isn't empty,
      // we ensure that the queue is empty and all workers are idle.
      const stats = pool.stats();
      apiLogger.debug(JSON.stringify(stats, null, 2));
      if (
        stats.pendingTasks === 0 &&
        stats.totalWorkers === stats.idleWorkers
      ) {
        await pool.terminate();
      }
    }
  }
);

router.get(`/preview`, async (req: PreviewHandlerRequest, res) => {
  const service: ServiceNames = req.query.service;
  const template: string = req.query.template;
  let templateData: unknown;
  try {
    templateData = await getTemplateData(req.headers, {
      service,
      template,
    });
  } catch (error) {
    return res.status(500).send({
      errors: [
        {
          status: 500,
          statusText: 'Internal server error',
          detail: error,
        },
      ],
    });
  }
  const orientationOption = processOrientationOption(req);

  const url = `http://localhost:${config?.webPort}?service=${service}&template=${template}`;

  try {
    const pdfBuffer = await previewPdf(
      url,
      {
        service,
        template,
      },
      templateData as Record<string, unknown>,
      orientationOption // could later turn into a full options object for other things outside orientation.
    );
    res.set('Content-Type', 'application/pdf');
    res.status(200).send(pdfBuffer);
  } catch (error: unknown) {
    if (error instanceof Error) {
      // error.code is not part of the Error definition for TS inside of Node. Choices: delete the usage of code, or, force a new definition.
      apiLogger.error(`${error.message}`);
      // res.status((error.code as number) || 500).send(error.message);
      res.status(500).send(error.message); // only here as example, we don't want to force a 500 every time.
    }
  }
});

router.get('/healthz', (_req, res, _next) => {
  return res.status(200).send('Build assets available');
});

router.get(`${config?.APIPrefix}/v1/openapi.json`, (_req, res, _next) => {
  fs.readFile('./docs/openapi.json', 'utf8', (err, data) => {
    if (err) {
      apiLogger.error(err);
      return res
        .status(500)
        .send(`An error occurred while fetching the OpenAPI spec : ${err}`);
    } else {
      return res.json(JSON.parse(data));
    }
  });
});

export default router;
