import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { auth } from '../auth';
import { config } from '../config';

/**
 * API reference, rendered by Stoplight Elements from the API's own OpenAPI
 * description (GET /v1/openapi.json), which the API tests keep in step with
 * its routes.
 *
 * Elements is loaded from a CDN as its prebuilt web component, and only on
 * this page: it bundles its own React (so it can't clash with ours), and it's
 * about 2 MB.
 */

const ELEMENTS = 'https://cdn.jsdelivr.net/npm/@stoplight/elements@9.0.29';

let loading: Promise<void> | null = null;

const loadElements = (): Promise<void> =>
    (loading ??= new Promise<void>((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = `${ELEMENTS}/styles.min.css`;
        document.head.appendChild(css);
        const script = document.createElement('script');
        script.src = `${ELEMENTS}/web-components.min.js`;
        script.onload = () => customElements.whenDefined('elements-api').then(() => resolve());
        script.onerror = () => {
            loading = null;
            reject(new Error(`couldn't load Stoplight Elements from ${ELEMENTS}`));
        };
        document.head.appendChild(script);
    }));

/** "Try it" needs a bearer token: a signed-in user's ID token works (as does any API key) */
const CopyToken = () => {
    const [copied, setCopied] = useState<string | null>(null);
    const copy = async () => {
        const token = await auth.currentUser?.getIdToken();
        if (!token) return;
        await navigator.clipboard.writeText(token);
        setCopied('copied; it expires within an hour');
    };
    return (
        <span className="muted">
            Try it needs a bearer token: an API key, or{' '}
            <button className="link" onClick={copy}>
                copy my sign-in token
            </button>
            {copied && ` (${copied})`}
        </span>
    );
};

export const ApiDocsPage = () => {
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [top, setTop] = useState(0);
    const container = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        loadElements()
            .then(() => setReady(true))
            .catch((e) => setError((e as Error).message));
    }, []);

    // fill the rest of the window: Elements' sidebar layout scrolls inside its own box
    useLayoutEffect(() => {
        const measure = () => setTop(container.current?.getBoundingClientRect().top ?? 0);
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [ready]);

    useLayoutEffect(() => {
        const el = container.current;
        if (!ready || !el) return;
        // created by hand, so Elements sees its (camelCase) attributes as it expects
        const docs = document.createElement('elements-api');
        docs.setAttribute('apiDescriptionUrl', `${config.apiBaseUrl}/openapi.json`);
        docs.setAttribute('router', 'hash'); // its own navigation stays out of react-router's way
        docs.setAttribute('layout', 'sidebar');
        docs.setAttribute('hideExport', 'true');
        el.replaceChildren(docs);
        return () => el.replaceChildren();
    }, [ready]);

    return (
        <>
            <div className="row api-docs-bar">
                <CopyToken />
                <a className="muted" href={`${config.apiBaseUrl}/openapi.json`} target="_blank" rel="noreferrer">
                    openapi.json
                </a>
            </div>
            {error && <p className="error">{error}</p>}
            {!ready && !error && <p className="muted">Loading the API reference…</p>}
            <div ref={container} className="api-docs" style={{ height: `calc(100vh - ${top}px)` }} />
        </>
    );
};
