# Python dependencies for Linux x86-64

The cloud runs **CPython 3.12** on Debian 12 (glibc 2.36), x86-64. Dependencies go into `stage/vendor/` and are found through `PYTHONPATH=vendor` (set by `templates/python.sh`). The runtime never runs `pip install`.

Wheels installed by a plain `pip install` on the user's machine match *that* machine (macOS arm64, Windows, Python 3.13…). Packages with C extensions (`pydantic-core`, `orjson`, `numpy`, `psycopg`, `uvloop`, `httptools`, `cryptography`, …) then fail in the cloud with `ImportError: … invalid ELF header` or `No module named 'pydantic_core._pydantic_core'`. Always install for the target explicitly.

## 1. Get a pinned requirements list

| Project uses | Command |
|-|-|
| `requirements.txt` | use it (skip `-r requirements-dev.txt` and test extras) |
| uv (`uv.lock`) | `uv export --no-dev --no-hashes --format requirements-txt -o .zcode-site/requirements.txt` |
| Poetry | `poetry export --without dev -f requirements.txt --without-hashes -o .zcode-site/requirements.txt` (Poetry 2 needs `poetry-plugin-export`) |
| Pipenv | `pipenv requirements`, saved to `.zcode-site/requirements.txt` |
| only `pyproject.toml` dependencies | write them to `.zcode-site/requirements.txt` |

Add the server you start with if it isn't listed: `uvicorn` for ASGI (FastAPI, Starlette), `gunicorn` for WSGI (Flask, Django). Prefer plain `uvicorn` over `uvicorn[standard]`: the extras (`uvloop`, `httptools`, `watchfiles`) are native and not needed.

Check `requires-python` and the code for syntax newer than 3.12 (e.g. PEP 695 is fine, 3.13-only stdlib APIs are not).

## 2. Cross-install with pip

Any local Python 3 with pip works (`python3` on macOS/Linux, `py -3` or `python` on Windows; the local version doesn't matter, `--python-version` decides). One line, so it pastes into any shell:

```
python3 -m pip install --no-compile --upgrade --target .zcode-site/stage/vendor --platform manylinux_2_28_x86_64 --platform manylinux2014_x86_64 --python-version 3.12 --implementation cp --only-binary=:all: -r .zcode-site/requirements.txt
```

- `--only-binary=:all:` is required by pip with `--platform`; pip then never builds anything locally.
- Without `--python-version 3.12`, pip picks wheels for the local Python and C extensions fail to import in the cloud.
- `manylinux_2_28` and `manylinux2014` (= `manylinux_2_17`) wheels both run on glibc 2.36. Don't add `musllinux` or `macosx` platforms.

### "No matching distribution found"

The package publishes no wheel for this platform/version.

- **Pure-Python package with only an sdist**: build a wheel locally — it is platform independent — and install it without the platform flags:
  `python3 -m pip wheel --no-deps -w .zcode-site/wheels "<pkg>==<version>"` then
  `python3 -m pip install --no-deps --no-compile -t .zcode-site/stage/vendor .zcode-site/wheels/*.whl`
  (check the wheel name ends in `-py3-none-any.whl`).
- **Package with C extensions and no manylinux wheel**: use a newer version that ships wheels, or a pure-Python or `-binary` replacement. Otherwise tell the user the feature can't run in the cloud.
- **Version pinned too old for 3.12**: old `numpy`/`pandas` pins have no cp312 wheels; upgrade the pin to a version that supports Python 3.12 and re-run the app's tests if there are any.

Packages that need system libraries missing from the image (`pycairo`, `PyGObject`, `weasyprint`, `python-magic`) can't run; replace them or tell the user.

## 3. Check the result

- `.zcode-site/stage/vendor` contains the packages. Don't rely on `vendor/bin`: console scripts there point at the build machine's interpreter, so `start.sh` always uses `python3 -m <module>`.
- `zcode-site deploy` verifies every `*.so` in `vendor/` is linux x86-64.
- Size: scientific stacks are big (`numpy` + `pandas` ≈ 100 MB unpacked). PyTorch, TensorFlow and similar exceed the package limits; tell the user.
- With native wheels in `vendor/`, `zcode-site check` skips on macOS/Windows; run the app from its normal environment with the same start command and check that `/` returns 200. The cloud health check is the final check.
