import { runningApiTests, tearDown } from './environment';

export default async () => {
    if (runningApiTests()) await tearDown();
};
