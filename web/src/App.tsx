import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, logOut, useAuth } from './auth';
import { AnnotationPage, AnnotationsPage } from './pages/Annotations';
import { ApiDocsPage } from './pages/ApiDocs';
import { CodecLab } from './pages/CodecLab';
import { LoginPage } from './pages/Login';
import { SchemaPage, SchemasPage } from './pages/Schemas';
import { SoundPage, SoundsPage } from './pages/Sounds';
import { ApiKeysPage, MePage, UserPage } from './pages/Users';

/**
 * Routes mirror the API's resource structure, so that any API href can be
 * turned into an app route by stripping the API root (see `appPath`).
 */
export const App = () => (
    <AuthProvider>
        <BrowserRouter>
            <Routes>
                {/* hidden: not in the nav, and no sign-in needed */}
                <Route path="labs/codec" element={<CodecLab />} />
                <Route element={<Layout />}>
                    <Route index element={<Navigate to="/sounds" replace />} />
                    <Route path="sounds" element={<SoundsPage />} />
                    <Route path="sounds/:soundId" element={<SoundPage />} />
                    <Route path="sounds/:soundId/annotations" element={<AnnotationsPage />} />
                    <Route path="annotations" element={<AnnotationsPage />} />
                    <Route path="annotations/:annotationId" element={<AnnotationPage />} />
                    <Route path="annotation-schemas" element={<SchemasPage />} />
                    <Route path="annotation-schemas/:ref" element={<SchemaPage />} />
                    <Route path="users/me" element={<Navigate to="/me" replace />} />
                    <Route path="users/:userId" element={<UserPage />} />
                    <Route path="users/:userId/sounds" element={<SoundsPage />} />
                    <Route path="users/:userId/annotations" element={<AnnotationsPage />} />
                    <Route path="me" element={<MePage />} />
                    <Route path="api-keys" element={<ApiKeysPage />} />
                    <Route path="api-docs" element={<ApiDocsPage />} />
                    <Route path="*" element={<p>Not found.</p>} />
                </Route>
            </Routes>
        </BrowserRouter>
    </AuthProvider>
);

const Layout = () => {
    const { user, loading } = useAuth();
    const { pathname } = useLocation();
    if (loading) return <p className="page">Loading…</p>;
    if (!user) return <LoginPage />;
    return (
        <>
            <header className="nav">
                <strong className="brand">cochlea</strong>
                <NavLink to="/sounds" end>Sounds</NavLink>
                <NavLink to="/annotations" end>Annotations</NavLink>
                <NavLink to="/annotation-schemas" end>Schemas</NavLink>
                <NavLink to="/api-docs">API</NavLink>
                <span className="spacer" />
                <NavLink to="/me">{user.email}</NavLink>
                <NavLink to="/api-keys">API keys</NavLink>
                <button className="link" onClick={() => logOut()}>Sign out</button>
            </header>
            {/* the API reference has its own sidebar layout, and wants the whole width */}
            <main className={pathname.startsWith('/api-docs') ? 'page wide' : 'page'}>
                <Outlet />
            </main>
        </>
    );
};
