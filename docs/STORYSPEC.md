# StoryMaker StorySpec

`story.yaml` is the closed, competition-only structure for one English
interactive story. It intentionally supports only pages, labelled choices,
good endings, page text, and illustrations.

```yaml
specVersion: storymaker/v1alpha1
kind: Story
metadata:
  slug: lost-rabbit
start: start
nodes:
  start:
    content: { $ref: content://lost-rabbit/chapters/start#fragments/text }
    choices:
      Follow the lantern: { target: lantern-path }
      Walk beside the river: { target: river-path }
  lantern-path:
    content: { $ref: content://lost-rabbit/chapters/lantern-path#fragments/text }
    next: ending-lantern
  river-path:
    content: { $ref: content://lost-rabbit/chapters/river-path#fragments/text }
    next: ending-river
  ending-lantern:
    type: ending
    content: { $ref: content://lost-rabbit/chapters/ending-lantern#fragments/text }
    ending: { endingId: lantern-home, endingType: good }
  ending-river:
    type: ending
    content: { $ref: content://lost-rabbit/chapters/ending-river#fragments/text }
    ending: { endingId: river-home, endingType: good }
```

In JSON passed to `update_story_structure`, each choice value has the same
object shape: `"Follow the lantern": { "target": "lantern-path" }`.

## Rules

- The only top-level keys are `specVersion`, `kind`, `metadata`, `start`, and
  `nodes`.
- `specVersion` is exactly `storymaker/v1alpha1`; `kind` is exactly `Story`.
- `metadata` has only lowercase-hyphen `slug`.
- Every node has exactly one `content` ref in the form
  `content://<metadata.slug>/chapters/<chapter-slug>#fragments/text`.
- A story has at least one node and `start` names one of its nodes.
- A non-ending node has exactly one of `next` or a non-empty `choices` object.
- A choice has only `target`; its object key is the text shown to the reader.
- An ending has `type: ending`, no `next` or `choices`, and
  `ending: { endingId, endingType: good }`.
- Unknown fields, extensions, alternate ending types, and gameplay data are
  invalid. A rejected structure never changes the workspace revision.

## Workspace files

Only these paths may exist in a StoryMaker workspace:

- `story.yaml`
- `meta.json`
- `media.json`
- `content/<chapter-slug>.en.txt`
- `media/<chapter-slug>.png|jpg|jpeg|webp`

`meta.json` stores the reader title supplied to `create_story`; it is not part
of `story.yaml`. Text is English-only in this competition build.
