// A sticky comment is the one comment a job keeps current on a pull request: it opens with the job's marker and is
// written under the repository token. Every job that keeps one finds it here, so no two finders can disagree.

import { z } from "zod";

/** The login GITHUB_TOKEN's writes carry. */
export const BOT_LOGIN = "github-actions[bot]";

/** What `gh api <issue>/comments --paginate --slurp` answers: one array per page. */
export const issueCommentsPages = z.array(
  z.array(
    z.object({
      id: z.number(),
      body: z.string().optional(),
      // null once the author's account is gone.
      user: z.object({ login: z.string() }).nullable(),
    }),
  ),
);

export type IssueComment = z.infer<typeof issueCommentsPages>[number][number];

/** The bot's own comment that opens with `marker`, or null. A reply quoting the comment carries the marker mid-text,
 *  and anyone can open a comment with it, so the marker alone would hand a human's comment to the job. */
export function stickyComment(
  comments: readonly IssueComment[],
  marker: string,
): IssueComment | null {
  const own = comments.find(
    (comment) => comment.user?.login === BOT_LOGIN && comment.body?.startsWith(marker) === true,
  );
  return own ?? null;
}
