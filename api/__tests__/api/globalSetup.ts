import { runningApiTests, setUp } from './environment';

export default async () => {
    if (runningApiTests()) await setUp();
};
