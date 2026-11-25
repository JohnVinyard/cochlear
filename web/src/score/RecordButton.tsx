import { setRecording, useScore } from './store';

/**
 * Starts and pauses recording the score from anywhere (it's in the header).
 * Pausing keeps what's been recorded; the score page clears it.
 */
export const RecordButton = () => {
    const { recording, uid } = useScore();
    if (uid === null) return null;
    const label = recording ? 'Pause recording' : 'Record what you play';
    return (
        <button
            type="button"
            className={recording ? 'record-button recording' : 'record-button'}
            aria-pressed={recording}
            aria-label={label}
            title={label}
            onClick={() => setRecording(!recording)}
        >
            <span className={recording ? 'icon-pause' : 'icon-record'} aria-hidden="true" />
        </button>
    );
};
