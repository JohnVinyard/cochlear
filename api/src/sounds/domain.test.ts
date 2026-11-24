/** @group unit */
import { MAX_FORMAT_METADATA_BYTES, type NewSound, validateFormat, validateNewSound } from './domain';

const format = { url: 'https://example.com/a.mp3', mimeType: 'audio/mpeg', metadata: { bitrate: 128000 } };

const sound = (overrides: Partial<NewSound> = {}): NewSound => ({
    audioUrl: 'https://example.com/a.wav',
    infoUrl: null,
    licenseType: 'https://creativecommons.org/licenses/by/4.0',
    title: null,
    durationSeconds: 1,
    formats: [],
    ...overrides,
});

describe('sound formats', () => {
    it('accept RFC 6838 media types, normalised to lowercase', () => {
        for (const mimeType of ['audio/mpeg', 'Audio/WAV', 'audio/vnd.cochlea.sprs+json', 'application/octet-stream']) {
            const checked = validateFormat({ ...format, mimeType });
            expect(checked.errors).toEqual([]);
            expect(checked.format.mimeType).toBe(mimeType.toLowerCase());
        }
    });

    it('reject anything else', () => {
        const bad = [
            { ...format, mimeType: 'mpeg' },
            { ...format, mimeType: 'audio/mpeg; rate=44100' },
            { ...format, mimeType: '/mpeg' },
            { ...format, url: 'file:///a.mp3' },
            { ...format, metadata: [] as unknown as Record<string, unknown> },
            { ...format, metadata: { big: 'x'.repeat(MAX_FORMAT_METADATA_BYTES) } },
        ];
        for (const f of bad) expect(validateFormat(f).errors).toHaveLength(1);
    });

    it('registered with a sound must have different urls, and are labelled in errors', () => {
        expect(validateNewSound(sound({ formats: [format, format] })).errors).toEqual(['formats must have different urls']);
        const { errors } = validateNewSound(sound({ formats: [format, { ...format, url: 'x', mimeType: 'y' }] }));
        expect(errors.every((e) => e.startsWith('formats[1]'))).toBe(true);
    });
});
