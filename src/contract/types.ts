/** The deliberately closed contract used by the StoryMaker contest app. */
export interface Ref { $ref: string }

export interface Choice {
  /** The object key is the reader-facing choice label. */
  target: string;
}

export interface Ending {
  endingId: string;
  endingType: "good";
}

export interface Node {
  content: Ref;
  next?: string;
  choices?: Record<string, Choice>;
  type?: "ending";
  ending?: Ending;
}

export interface StorySpec {
  specVersion: "storymaker/v1alpha1";
  kind: "Story";
  metadata: { slug: string };
  start: string;
  nodes: Record<string, Node>;
}

export interface Diagnostic {
  severity: "error" | "warning";
  path: string;
  message: string;
}
