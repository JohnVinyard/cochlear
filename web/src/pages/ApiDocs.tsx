import { useLayoutEffect, useRef, useState } from 'react';
import { auth } from '../auth';
import { config } from '../config';

/**
 * API reference, rendered by Stoplight Elements from the API's own OpenAPI
 * description (GET /v1/openapi.json), which the API tests keep in step with
 * its routes.
 *
 * Elements runs in an iframe (api-reference.html, src/apiReference.ts): its
 * stylesheet carries a global CSS reset that would restyle the whole app,
 * and keep doing so after you'd left this page. In its own document it can't
 * touch ours, and its ~2 MB of script only loads here.
 */

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
    const [top, setTop] = useState(0);
    const frame = useRef<HTMLIFrameElement | null>(null);

    // fill the rest of the window: Elements' sidebar layout scrolls inside its own box
    useLayoutEffect(() => {
        const measure = () => setTop(frame.current?.getBoundingClientRect().top ?? 0);
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, []);

    return (
        <>
            <div className="row api-docs-bar">
                <CopyToken />
                <a className="muted" href={`${config.apiBaseUrl}/openapi.json`} target="_blank" rel="noreferrer">
                    openapi.json
                </a>
            </div>
            <iframe
                ref={frame}
                className="api-docs"
                title="API reference"
                src="/api-reference.html"
                style={{ height: `calc(100vh - ${top}px)` }}
            />
        </>
    );
};
