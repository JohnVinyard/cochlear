/**
 * The API reference page (api-reference.html), shown in an iframe by the
 * app's /api-docs route. It renders the API's own OpenAPI description, from
 * the configured API URL (never from the page's URL, so nobody can link to
 * our origin rendering some other spec).
 */
import { config } from './config';

const docs = document.createElement('elements-api');
// Elements reads its (camelCase) attributes as written
docs.setAttribute('apiDescriptionUrl', `${config.apiBaseUrl}/openapi.json`);
docs.setAttribute('router', 'hash');
docs.setAttribute('layout', 'sidebar');
docs.setAttribute('hideExport', 'true');
document.body.appendChild(docs);
