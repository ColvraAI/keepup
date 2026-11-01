import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

export async function reportBug(ticket: string): Promise<void> {
  await octokit.issues.create({ owner: 'northwind', repo: 'parcel', title: 'Bug from support', body: ticket });
}
