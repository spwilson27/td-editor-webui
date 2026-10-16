# td_python_debug.tox

The td-mcp debug server component (`/project1/td_python_debug`), used to generate the validation project
`.validate/validate.toe` (`scripts/make_validate_toe.py`). Self-contained: the td_plugin modules are embedded as DATs, Token is blank
(generated at first start), Port 8765 (the validation toe overrides it), Auto Start on.

It is a copy of `tox/td_python_debug.tox` from the td-mcp repository (`td_python_debug.manifest.json` lists the sha256 of every
embedded DAT). To refresh: in a td-mcp checkout run `python scripts/build_tox.py`, then copy `tox/td_python_debug.tox` and
`tox/td_python_debug.manifest.json` here.
