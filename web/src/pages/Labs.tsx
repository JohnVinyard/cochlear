import { Link } from 'react-router';

/**
 * Experiments that aren't part of the annotation app proper. Each lab has
 * its own route under /labs; add new ones here.
 */
const LABS = [
    {
        path: '/labs/codec',
        title: 'Codec lab',
        description:
            'An experimental audio codec whose encoded form is a JSON tree of parameters for a pluggable decoder ' +
            '(a sampler, a sequencer and a gammatone extension), decoded by Rust compiled to WebAssembly. ' +
            'Explore example documents, set the tree depth, and play any node in context.',
    },
];

export const LabsPage = () => (
    <>
        <h1>Labs</h1>
        <p className="muted">Experiments, related to the annotation app but not part of it (yet).</p>
        <ul className="labs">
            {LABS.map((lab) => (
                <li key={lab.path} className="panel">
                    <h2>
                        <Link to={lab.path}>{lab.title}</Link>
                    </h2>
                    <p>{lab.description}</p>
                </li>
            ))}
        </ul>
    </>
);
