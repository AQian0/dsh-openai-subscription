# Third-party notices

## OpenAI / ChatGPT icon — Lobe Icons

The monochrome SVG geometry embedded in `src/client.ts` is from
[`@lobehub/icons-static-svg` 1.95.0, `icons/openai.svg`](https://www.npmjs.com/package/@lobehub/icons-static-svg/v/1.95.0).
Upstream: [Lobe Icons](https://github.com/lobehub/lobe-icons),
[icon preview](https://lobehub.com/icons/openai).

The path geometry is unchanged. The wrapper is adapted to React, accepts a size
and CSS class, inherits `currentColor`, and is hidden from assistive technology
because adjacent text provides the label. The same component is used in the
settings header and navigation; no icon library or remote image is loaded at runtime.

OpenAI and ChatGPT names and marks belong to their respective owners. Use here
identifies the supported service and does not imply affiliation or endorsement.
The software license below does not grant trademark rights.

## DeepSeek Harness patch anchors

The optional `scripts/patch-dsh-settings-icons.mjs` includes small source anchors
from DeepSeek Harness's MIT-licensed settings and slots packages.

Copyright (c) 2026 DeepSeek

The MIT permission and disclaimer below also apply to these anchors; preserve
this copyright notice when distributing them. The extension is local to this
project and is not an upstream DeepSeek release.

## MIT license text

Reproduced from `@lobehub/icons` 1.95.0, `LICENSE` (the static SVG package
also declares MIT). The DeepSeek Harness packages use the same MIT terms with
the DeepSeek copyright notice above:


```text
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
