export const config = {
    apiBaseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8080/v1',
    firebaseProjectId: (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined) ?? 'demo-cochlea',
    firebaseApiKey: (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined) ?? 'fake-api-key',
    firebaseAuthEmulatorUrl: import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL as string | undefined,
};
