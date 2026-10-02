#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stack Frame Visualizer for C -- gdb driver (milestone M1).

This file is executed *inside* gdb, for example::

    gdb -q -nx -batch -x python/gdb_stackviz.py --args .stackviz/a.out

The VS Code extension listens on 127.0.0.1 and hands its port to gdb through the
environment:

    STACKVIZ_PORT     TCP port of the extension
    STACKVIZ_OPTIONS  JSON {"maxSteps":int,"maxDepth":int,
                            "recordLocals":bool,"maxArrayItems":int}

The driver starts the inferior, steps it one source line at a time, compares
consecutive call-stack snapshots and streams one JSON object per line (NDJSON)
to the extension.  Only the Python standard library and the ``gdb`` module are
used, so the file can be run by any gdb build with Python 3 support.

Design notes
------------
* gdb's default ``set step-mode off`` makes ``step`` walk over functions that
  have no debug information (libc, the C runtime, ...), so the recording stays
  inside the program that the user actually compiled.
* The call stack is rebuilt from snapshots: the longest common prefix of two
  snapshots is unchanged, frames that appear are "call" events, frames that
  disappear are "return" events and the new top frame always emits "line".
* Every frame gets a unique frameId, so the same (recursive) function appears
  as many times as it is active.
"""

import json
import os
import re
import socket
import sys
import time

import gdb  # provided by gdb's embedded Python


DEFAULT_OPTIONS = {
    "host": "127.0.0.1",
    "port": None,
    "maxSteps": 5000,
    "maxDepth": 100,
    "recordLocals": True,
    "maxArrayItems": 10,
    # Absolute paths of the C sources the user is actually writing. Frames from
    # other files (glibc, the C runtime, ...) are hidden and stepped over.
    "sources": [],
    # "auto" uses the cheap top-frame diff with periodic resyncs, "full" always
    # walks the whole stack (slower, handy for comparing the two).
    "snapshot": "auto",
}

MAX_VARIABLES = 20
MAX_STRUCT_FIELDS = 10
MAX_STRING_CHARS = 100

# Set STACKVIZ_TIMING=1 to print where a recording spends its time.
TIMING = os.environ.get("STACKVIZ_TIMING") == "1"
TIMINGS = {"snapshot": 0.0, "update": 0.0, "step": 0.0, "leave": 0.0, "vars": 0.0}


def timed(phase, action):
    if not TIMING:
        return action()
    started = time.perf_counter()
    try:
        return action()
    finally:
        TIMINGS[phase] += time.perf_counter() - started


def log(message):
    """Write a line to gdb's stderr (shown as [gdb] ... in the extension)."""
    sys.stderr.write("[stackviz] %s\n" % message)
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# options
# ---------------------------------------------------------------------------


def load_options():
    options = dict(DEFAULT_OPTIONS)
    raw = os.environ.get("STACKVIZ_OPTIONS")
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                options.update(parsed)
        except Exception as exc:  # noqa: BLE001 - never fail because of options
            log("ignoring malformed STACKVIZ_OPTIONS: %s" % exc)

    raw_sources = os.environ.get("STACKVIZ_SOURCES")
    if raw_sources:
        try:
            parsed_sources = json.loads(raw_sources)
            if isinstance(parsed_sources, list):
                options["sources"] = [str(entry) for entry in parsed_sources]
        except Exception as exc:  # noqa: BLE001
            log("ignoring malformed STACKVIZ_SOURCES: %s" % exc)

    port = os.environ.get("STACKVIZ_PORT")
    if port:
        try:
            options["port"] = int(port)
        except ValueError:
            log("ignoring malformed STACKVIZ_PORT: %r" % port)

    for key, fallback in (("maxSteps", 5000), ("maxDepth", 100), ("maxArrayItems", 10)):
        try:
            options[key] = int(options[key])
        except (TypeError, ValueError):
            options[key] = fallback
    options["maxSteps"] = max(1, options["maxSteps"])
    options["maxDepth"] = max(1, options["maxDepth"])
    options["maxArrayItems"] = max(0, options["maxArrayItems"])
    options["recordLocals"] = bool(options["recordLocals"])
    return options


#: Directories that never contain the program the user is learning from.
SYSTEM_PREFIXES = ("/usr/", "/lib/", "/lib64/", "/bin/", "/sbin/", "/etc/", "/var/")


class Sources(object):
    """Decides which frames belong to the program the user is writing.

    With the full glibc debug information installed (libc6-dbg), plain ``step``
    happily walks into printf().  The extension therefore tells the driver which
    files are the user's; everything else is hidden from the snapshots and left
    again with ``finish``.

    Two modes are supported:

    ``list``       the files passed through STACKVIZ_SOURCES are the user code;
    ``heuristic``  no reliable file list (hand written runs, or a binary whose
                   sources are unknown).  A frame counts as user code when its
                   source path looks like a real project file: an absolute path
                   outside the system directories.  gdb reports library frames
                   as relative paths such as "./csu/../csu/libc-start.c", so
                   they are filtered out.  This mode never drops frames whose
                   file is an absolute path, so a user program whose sources
                   moved still shows up.
    """

    def __init__(self, options):
        self.files = set()
        for entry in options.get("sources") or []:
            try:
                self.files.add(os.path.realpath(entry))
            except Exception:  # noqa: BLE001
                continue
        self.mode = "list" if self.files else "heuristic"
        # is_user_file() runs once per frame and per step; without this cache a
        # 1000 frame stack would pay 1000 realpath() calls (syscalls) per step.
        self._cache = {}

    def is_user_file(self, file_name):
        cached = self._cache.get(file_name)
        if cached is not None:
            return cached
        if len(self._cache) > 5000:
            self._cache.clear()
        result = self._resolve(file_name)
        self._cache[file_name] = result
        return result

    def _resolve(self, file_name):
        if self.mode == "list":
            return self._in_list(file_name)
        return self._looks_like_project_file(file_name)

    def use_heuristic(self, reason):
        if self.mode != "heuristic":
            self.mode = "heuristic"
            self._cache.clear()
            log("switching to the path based source filter: %s" % reason)

    def _in_list(self, file_name):
        if not file_name:
            return False
        try:
            return os.path.realpath(file_name) in self.files
        except Exception:  # noqa: BLE001
            return file_name in self.files

    @staticmethod
    def _looks_like_project_file(file_name):
        if not file_name or not os.path.isabs(file_name):
            # Empty paths and relative paths such as "./csu/../csu/libc-start.c"
            # come from libraries whose sources are not on this machine.
            return False
        normalized = os.path.realpath(file_name)
        for prefix in SYSTEM_PREFIXES:
            if normalized.startswith(prefix):
                return False
        return True


# ---------------------------------------------------------------------------
# transport
# ---------------------------------------------------------------------------


def connect(options, timeout=15.0):
    port = options.get("port")
    if not port:
        raise RuntimeError("STACKVIZ_PORT is not set, cannot reach the extension")

    deadline = time.time() + timeout
    while True:
        try:
            sock = socket.create_connection((options["host"], port), timeout=5.0)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            log("connected to the extension on %s:%d" % (options["host"], port))
            return sock
        except OSError as exc:
            if time.time() >= deadline:
                raise RuntimeError("cannot connect to the extension on port %d: %s" % (port, exc))
            time.sleep(0.2)


class Sender(object):
    """Writes NDJSON events; never raises, so gdb is not disturbed."""

    def __init__(self, sock):
        self._sock = sock
        self._closed = False
        self.count = 0

    def send(self, event):
        if self._closed:
            return False
        payload = json.dumps(event, ensure_ascii=False)
        try:
            self._sock.sendall((payload + "\n").encode("utf-8"))
        except OSError as exc:
            self._closed = True
            log("connection to the extension lost: %s" % exc)
            return False
        self.count += 1
        if self.count % 250 == 0:
            log("%d events sent" % self.count)
        return True

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass


def timestamp():
    return int(time.time() * 1000)


def synthetic_event(kind, message, context=None):
    """Build an "exception"/"exit" event, anchored at the current top frame."""
    event = {
        "type": kind,
        "frameId": 0,
        "functionName": "<stackviz>",
        "file": "",
        "line": 0,
        "depth": 0,
        "timestamp": timestamp(),
        "message": message,
    }
    if context:
        event["frameId"] = context.get("id", 0)
        event["functionName"] = context.get("name") or "<stackviz>"
        event["file"] = context.get("file") or ""
        event["line"] = context.get("line") or 0
        event["depth"] = context.get("depth") or 0
    return event


# ---------------------------------------------------------------------------
# variable preview (read-only, heavily guarded)
# ---------------------------------------------------------------------------


def is_char_type(value_type):
    try:
        stripped = value_type.strip_typedefs()
        if stripped.code == gdb.TYPE_CODE_CHAR:
            return True
        return stripped.code == gdb.TYPE_CODE_INT and stripped.sizeof == 1 and stripped.name in (
            "char",
            "signed char",
            "unsigned char",
        )
    except Exception:  # noqa: BLE001
        return False


def array_length(value_type):
    try:
        low, high = value_type.range()
        return max(0, int(high) - int(low) + 1)
    except Exception:  # noqa: BLE001
        return 0


def format_string(value, options):
    try:
        text = value.string(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        text = None
    if text is None:
        try:
            text = value.string()
        except Exception:  # noqa: BLE001
            return '"<unreadable>"'
    text = text.replace("\n", "\\n")
    if len(text) > MAX_STRING_CHARS:
        text = text[:MAX_STRING_CHARS] + "..."
    return '"%s"' % text


def format_value(value, options, depth=0):
    """Render a gdb.Value as a short, safe string."""
    if value is None or depth > 3:
        return "?"
    try:
        if value.is_optimized_out():
            return "<optimized out>"
    except Exception:  # noqa: BLE001
        pass

    try:
        value_type = value.type.strip_typedefs()
        code = value_type.code
    except Exception:  # noqa: BLE001
        return str(value)

    try:
        if code == gdb.TYPE_CODE_ARRAY:
            if is_char_type(value_type.target()):
                return format_string(value, options)
            count = array_length(value_type)
            limit = min(count, options["maxArrayItems"])
            items = []
            for index in range(limit):
                try:
                    items.append(format_value(value[index], options, depth + 1))
                except Exception:  # noqa: BLE001
                    items.append("?")
            tail = ", ..." if count > limit else ""
            return "[%s%s]" % (", ".join(items), tail)

        if code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            fields = value_type.fields()
            if not fields:
                return "<%s>" % (value_type.name or value_type.tag or "struct")
            parts = []
            for field in fields[:MAX_STRUCT_FIELDS]:
                try:
                    parts.append("%s = %s" % (field.name, format_value(value[field.name], options, depth + 1)))
                except Exception:  # noqa: BLE001
                    parts.append("%s = ?" % field.name)
            tail = ", ..." if len(fields) > MAX_STRUCT_FIELDS else ""
            return "{%s%s}" % (", ".join(parts), tail)

        if code in (gdb.TYPE_CODE_PTR, gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
            # Pointers are shown as an address only: no automatic dereference.
            try:
                return "0x%x" % (int(value) & ((1 << 64) - 1))
            except Exception:  # noqa: BLE001
                return str(value)

        text = str(value)
        if len(text) > MAX_STRING_CHARS:
            text = text[:MAX_STRING_CHARS] + "..."
        return text
    except Exception as exc:  # noqa: BLE001 - never let a value break the run
        return "<unreadable: %s>" % exc


def read_variables(frame, options):
    """Return (args, locals) dictionaries for one frame."""
    if not options["recordLocals"]:
        return None, None

    arguments = {}
    variables = {}
    try:
        block = frame.block()
    except Exception:  # noqa: BLE001 - no debug info at this pc
        return None, None

    guard = 0
    while block is not None and guard < 32:
        guard += 1
        try:
            if block.is_global or block.is_static:
                break
        except Exception:  # noqa: BLE001
            break

        try:
            symbols = list(block)
        except Exception:  # noqa: BLE001
            symbols = []

        for symbol in symbols:
            try:
                name = symbol.name
                if not name:
                    continue
                # Not every gdb build exposes every Symbol predicate.
                if getattr(symbol, "is_function", False) or getattr(symbol, "is_type", False):
                    continue
                if getattr(symbol, "is_argument", False):
                    arguments.setdefault(name, symbol)
                elif getattr(symbol, "is_variable", False):
                    variables.setdefault(name, symbol)
            except Exception:  # noqa: BLE001
                continue

        try:
            block = block.superblock
        except Exception:  # noqa: BLE001
            block = None

    out_args = {}
    out_locals = {}
    budget = MAX_VARIABLES
    for name, symbol in arguments.items():
        if budget <= 0:
            break
        budget -= 1
        out_args[name] = read_symbol(frame, symbol, options)
    for name, symbol in variables.items():
        if budget <= 0:
            break
        budget -= 1
        out_locals[name] = read_symbol(frame, symbol, options)
    return out_args, out_locals


def read_symbol(frame, symbol, options):
    try:
        value = symbol.value(frame)
    except Exception as exc:  # noqa: BLE001
        return "<unavailable: %s>" % exc
    return format_value(value, options)


# ---------------------------------------------------------------------------
# stack snapshots
# ---------------------------------------------------------------------------


def frame_location(frame):
    name = "<unknown>"
    try:
        name = frame.name() or "<unknown>"
    except Exception:  # noqa: BLE001
        pass

    file_name = None
    line = 0
    try:
        sal = frame.find_sal()
        if sal is not None:
            symtab = sal.symtab
            if symtab is not None:
                try:
                    file_name = symtab.fullname()
                except Exception:  # noqa: BLE001
                    file_name = symtab.filename
            line = int(sal.line or 0)
    except Exception:  # noqa: BLE001
        pass
    return name, file_name, line


def inferior_alive():
    try:
        inferior = gdb.selected_inferior()
    except Exception:  # noqa: BLE001
        return False
    if inferior is None:
        return False
    try:
        return inferior.pid != 0
    except Exception:  # noqa: BLE001
        return False


def identity_of(frame):
    """Stable identity of one *activation* of a function: its entry stack pointer.

    That value never changes between entering a function and returning from it,
    which is what lets two recursion levels of the same function be told apart.

    The plugin compiles with ``-fno-omit-frame-pointer``, so gdb can give us rbp
    and rsp.  Right after a call, before the callee's prologue has run, rbp still
    belongs to the caller - that case is detectable (both frames report the same
    rbp) and then the live rsp *is* the entry sp.  Once the prologue ran,
    ``push rbp; mov rbp,rsp`` means entry sp == rbp + 8.

    Returns None when the registers cannot be read; callers then fall back to the
    exact walk instead of guessing.
    """
    try:
        rbp = int(frame.read_register("rbp"))
        rsp = int(frame.read_register("rsp"))
    except Exception:  # noqa: BLE001
        return None

    try:
        older = frame.older()
    except Exception:  # noqa: BLE001
        older = None
    if older is not None:
        try:
            if int(older.read_register("rbp")) == rbp:
                # The prologue has not run yet, rbp is still the caller's.
                return rsp
        except Exception:  # noqa: BLE001
            pass

    if rbp == 0 or rbp < rsp:
        return rsp
    return rbp + 8


def describe_frame(frame):
    name, file_name, line = frame_location(frame)
    return {
        "name": name,
        "file": file_name,
        "line": line,
        "identity": identity_of(frame),
        "frame": frame,
    }


def describe_top():
    try:
        frame = gdb.newest_frame()
    except Exception:  # noqa: BLE001
        return None
    if frame is None:
        return None
    return describe_frame(frame)


def describe_parent(frame):
    try:
        older = frame.older()
    except Exception:  # noqa: BLE001
        return None
    if older is None:
        return None
    return describe_frame(older)


#: function name + file -> line of its closing brace
_LAST_LINE_CACHE = {}


def function_last_line(frame):
    """Line number of the function's closing brace, or None."""
    try:
        block = frame.block()
    except Exception:  # noqa: BLE001
        return None
    guard = 0
    while block is not None and block.function is None and guard < 16:
        try:
            block = block.superblock
        except Exception:  # noqa: BLE001
            return None
        guard += 1
    if block is None:
        return None
    try:
        sal = gdb.find_pc_line(block.end - 1)
    except Exception:  # noqa: BLE001
        return None
    return sal.line if sal is not None else None


def at_return_instruction(frame):
    """True when the frame is stopped on the last line of its function.

    Two calls of the same function on one source line (``fib(n-1) + fib(n-2)``)
    can be entered inside a single ``step``: the callee returns and its sibling
    is called before gdb reports a new source line.  The snapshot then looks
    unchanged - same function, same file, same depth - which used to merge the
    two activations into one node.  Stopping on the function's closing brace is
    the signal: that activation is gone after the next step.
    """
    try:
        sal = frame.find_sal()
        line = sal.line if sal is not None else None
        symtab = sal.symtab if sal is not None else None
        key = (frame.name(), symtab.filename if symtab is not None else None)
    except Exception:  # noqa: BLE001
        return False
    if line is None:
        return False
    if key not in _LAST_LINE_CACHE:
        _LAST_LINE_CACHE[key] = function_last_line(frame)
    last = _LAST_LINE_CACHE[key]
    return last is not None and line == last


def take_snapshot(sources, max_depth, on_truncate=None):
    """Return the call stack, bottom (main) first: [(name, file, line, frame, id)].

    Frames that do not belong to the user's sources are skipped, so the recorded
    stack only ever mentions the program the user wrote.  Walking the whole
    stack makes gdb unwind every frame, which is the expensive part, so this is
    only used for the first snapshot, as a periodic resync and as a fallback.
    """
    try:
        frame = gdb.newest_frame()
    except Exception:  # noqa: BLE001
        return None
    if frame is None:
        return None

    frames = []
    guard = 0
    while frame is not None and guard < 20000:
        guard += 1
        name, file_name, line = frame_location(frame)
        if sources.is_user_file(file_name):
            frames.append((name, file_name, line, frame))
        try:
            frame = frame.older()
        except Exception:  # noqa: BLE001
            frame = None

    frames.reverse()
    if max_depth > 0 and len(frames) > max_depth:
        if on_truncate is not None:
            on_truncate(len(frames), max_depth)
        frames = frames[:max_depth]
    return frames


# ---------------------------------------------------------------------------
# call/return/line events
# ---------------------------------------------------------------------------


class Tracker(object):
    """Turns consecutive stack states into call/return/line events.

    Two paths produce those events:

    ``apply_incremental``  the normal path.  Stepping only changes the top of
                           the stack, so the previous entries are reused and
                           only the top frame (plus its parent, when the top
                           changed) is read.  Without this, gdb unwinds all 1000
                           frames after every single step, which dominated a
                           long recording.
    ``apply_full``         the exact walk.  Used for the first snapshot, as a
                           periodic resync, and whenever the stack changed in a
                           shape the cheap path does not expect.
    """

    #: Re-walk everything every N steps so a recording cannot drift.
    FULL_RESYNC_EVERY = 250

    def __init__(self, sender, options):
        self.sender = sender
        self.options = options
        self.next_frame_id = 1
        #: bottom (main) -> top; each entry: id/name/file/line/depth/identity
        self.stack = []
        self._notes = set()
        # frameId -> (args, locals) as they were the last time this frame was the
        # top frame.  "return" events use this so a return still shows the
        # arguments of the frame that is going away.
        self.last_known = {}
        self.steps_since_full = 0
        self.fast_path = options.get("snapshot", "auto") != "full"

    # -- bookkeeping ------------------------------------------------------
    def _remember(self, frame_id, args, locals_):
        if args or locals_:
            self.last_known[frame_id] = (args, locals_)
        if len(self.last_known) > 20000:
            for key in list(self.last_known)[:5000]:
                del self.last_known[key]

    def _new_entry(self, top, depth, returning=False):
        entry = {
            "id": self.next_frame_id,
            # Same shape as the entries built by apply_full(), so the cheap path
            # can hand its state over to a full snapshot at any time.
            "key": (top["name"], top["file"]),
            "name": top["name"],
            "file": top["file"],
            "line": top["line"],
            "depth": depth,
            "identity": top["identity"],
            #: True when this stop was at a "ret" instruction.
            "returning": returning,
        }
        self.next_frame_id += 1
        return entry

    def note(self, message):
        """Emit an "exception" event once per distinct message."""
        if message in self._notes:
            return True
        self._notes.add(message)
        context = self.stack[-1] if self.stack else None
        return self.sender.send(synthetic_event("exception", message, context))

    def exit(self, exit_code):
        context = self.stack[-1] if self.stack else None
        if exit_code is None:
            message = "the program finished"
        else:
            message = "the program exited with code %d" % exit_code
        return self.sender.send(synthetic_event("exit", message, context))

    def _emit(self, kind, entry, parent_id=None, args=None, locals_=None):
        event = {
            "type": kind,
            "frameId": entry["id"],
            "functionName": entry["name"],
            "file": entry["file"] or "",
            "line": entry["line"],
            "depth": entry["depth"],
            "timestamp": timestamp(),
        }
        if parent_id is not None:
            event["parentFrameId"] = parent_id
        if args:
            event["args"] = args
        if locals_:
            event["locals"] = locals_
        return self.sender.send(event)

    def _emit_call(self, entry, parent_id, frame):
        args, locals_ = read_variables(frame, self.options)
        self._remember(entry["id"], args, locals_)
        return self._emit("call", entry, parent_id, args, locals_)

    def _emit_line(self, entry, frame):
        args, locals_ = read_variables(frame, self.options)
        self._remember(entry["id"], args, locals_)
        return self._emit("line", entry, None, args, locals_)

    def _emit_return(self, entry):
        args, locals_ = self.last_known.pop(entry["id"], (None, None))
        return self._emit("return", entry, None, args, locals_)

    # -- snapshots --------------------------------------------------------
    def _too_deep(self, depth, on_truncate):
        max_depth = self.options["maxDepth"]
        if max_depth > 0 and depth > max_depth:
            if on_truncate is not None:
                on_truncate(depth, max_depth)
            return True
        return False

    def _same_activation(self, left, right):
        """True only with positive evidence that both frames are one activation.

        An unknown identity (None) must never count as a match here: the cheap
        path may only reuse the previous stack when it is sure, otherwise it
        falls back to the exact walk.
        """
        return left is not None and right is not None and left == right

    def apply_incremental(self, top, top_returns=False, on_truncate=None):
        """Cheap update from the top frame only.

        Returns True/False (did the recording survive), or None when the caller
        has to fall back to the exact walk.
        """
        if not self.fast_path or not self.stack or top is None or top["identity"] is None:
            return None
        if self.steps_since_full >= self.FULL_RESYNC_EVERY:
            return None
        max_depth = self.options["maxDepth"]
        if max_depth > 0 and len(self.stack) >= max_depth:
            # The reported stack is truncated, so its top is not the innermost
            # frame and reading variables from the newest frame would be wrong.
            # The exact walk knows how to cut the stack.
            return None

        previous_top = self.stack[-1]
        same_top = self._same_activation(top["identity"], previous_top["identity"]) and top["name"] == previous_top["name"]

        if previous_top.get("returning"):
            # The previous stop was on the function's closing brace, so that
            # activation is gone by now.  Coming back to its caller is
            # unambiguous; anything else (a sibling call entered from the same
            # source line) is left to the exact walk.
            if (
                len(self.stack) >= 2
                and self._same_activation(top["identity"], self.stack[-2]["identity"])
                and top["name"] == self.stack[-2]["name"]
            ):
                gone = self.stack.pop()
                alive = self._emit_return(gone)
                self.stack[-1]["line"] = top["line"]
                self.stack[-1]["returning"] = top_returns
                self.steps_since_full += 1
                return self._emit_line(self.stack[-1], top["frame"]) and alive
            return None

        if same_top and top["name"] == previous_top["name"]:
            # Same activation, a plain line step: nothing else can have changed.
            previous_top["line"] = top["line"]
            previous_top["returning"] = top_returns
            self.steps_since_full += 1
            return self._emit_line(previous_top, top["frame"])

        parent = describe_parent(top["frame"])

        if (
            parent is not None
            and parent["identity"] is not None
            and self._same_activation(parent["identity"], previous_top["identity"])
        ):
            # A call pushed one new frame on top of the previous one.
            if self._too_deep(len(self.stack) + 1, on_truncate):
                return None
            entry = self._new_entry(top, len(self.stack), top_returns)
            self.stack.append(entry)
            self.steps_since_full += 1
            alive = self._emit_call(entry, previous_top["id"], top["frame"])
            return self._emit_line(entry, top["frame"]) and alive

        if (
            len(self.stack) >= 2
            and self._same_activation(top["identity"], self.stack[-2]["identity"])
            and top["name"] == self.stack[-2]["name"]
        ):
            # The innermost frame returned to its caller.
            gone = self.stack.pop()
            alive = self._emit_return(gone)
            self.stack[-1]["line"] = top["line"]
            self.stack[-1]["returning"] = top_returns
            self.steps_since_full += 1
            return self._emit_line(self.stack[-1], top["frame"]) and alive

        if (
            parent is not None
            and len(self.stack) >= 2
            and self._same_activation(parent["identity"], self.stack[-2]["identity"])
            and parent["name"] == self.stack[-2]["name"]
        ):
            # The top activation was replaced (return + call within one step).
            gone = self.stack.pop()
            alive = self._emit_return(gone)
            entry = self._new_entry(top, len(self.stack), top_returns)
            self.stack.append(entry)
            self.steps_since_full += 1
            alive = self._emit_call(entry, self.stack[-2]["id"], top["frame"]) and alive
            return self._emit_line(entry, top["frame"]) and alive

        # Anything else (several frames popped, library hand-off, ...) needs the
        # exact walk.
        return None

    def apply_full(self, frames, top_returns=False, top_identity=None):
        """Apply one exact snapshot; returns False when the extension disappeared.

        The walk itself stays cheap: it only collects name/file/line per frame.
        Identities of unchanged frames are carried over from the previous stack,
        and only the top one is read (that is enough for the cheap path).
        """
        self.steps_since_full = 0
        current = []
        for index, item in enumerate(frames):
            current.append(
                {
                    "key": (item[0], item[1]),
                    "name": item[0],
                    "file": item[1],
                    "line": item[2],
                    "depth": index,
                    "identity": None,
                }
            )

        previous = self.stack
        prefix = 0
        while (
            prefix < len(previous)
            and prefix < len(current)
            # A frame that was sitting on a "ret" is gone by now, even if the
            # next stop looks identical (sibling call on the same source line).
            and not previous[prefix].get("returning")
            and previous[prefix]["key"] == current[prefix]["key"]
        ):
            current[prefix]["id"] = previous[prefix]["id"]
            current[prefix]["identity"] = previous[prefix]["identity"]
            prefix += 1

        alive = True

        # Frames that disappeared: the innermost one returns first.
        for index in range(len(previous) - 1, prefix - 1, -1):
            alive = self._emit_return(previous[index]) and alive

        # Frames that appeared: the outermost one is called first.
        top_frame = frames[-1][3] if frames else None
        for index in range(prefix, len(current)):
            entry = current[index]
            entry["id"] = self.next_frame_id
            self.next_frame_id += 1
            parent_id = current[index - 1]["id"] if index > 0 else None
            if index == len(current) - 1:
                alive = self._emit_call(entry, parent_id, top_frame) and alive
            else:
                alive = self._emit("call", entry, parent_id) and alive

        # The current top frame always reports its line.
        if current:
            current[-1]["identity"] = top_identity
            current[-1]["returning"] = top_returns
            alive = self._emit_line(current[-1], top_frame) and alive

        self.stack = current
        return alive


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------


def exit_code():
    try:
        value = gdb.parse_and_eval("$_exitcode")
        return int(value)
    except Exception:  # noqa: BLE001 - only available after the program exited
        return None


def configure_gdb():
    for command in (
        "set pagination off",
        "set confirm off",
        "set print frame-arguments none",
        # Step over functions without debug information (libc, crt, ...).
        "set step-mode off",
        # Never run scripts that a binary's debug info points at: the extension
        # loads this file explicitly with "gdb -x", so auto-loading is not
        # needed and leaving it enabled would be a way to run arbitrary code.
        "set auto-load off",
    ):
        try:
            gdb.execute(command)
        except gdb.error as exc:
            log("could not run %r: %s" % (command, exc))


def step_once():
    try:
        gdb.execute("step")
        return True
    except gdb.error as exc:
        log("single step stopped: %s" % exc)
        return False


def return_to_user_code(sources):
    """After a step, run out of library frames until the top frame is user code.

    Returns False when the inferior is gone, True otherwise: a failure to leave
    a library frame must never abort the whole recording.
    """
    for _ in range(16):
        if not inferior_alive():
            return False
        try:
            frame = gdb.newest_frame()
        except Exception:  # noqa: BLE001
            return False
        if frame is None:
            return False
        _name, file_name, _line = frame_location(frame)
        if sources.is_user_file(file_name):
            return True
        try:
            gdb.execute("finish")
        except gdb.error as exc:
            log("could not leave the library frame: %s" % exc)
            return True
    return True


def run(options, sender):
    tracker = Tracker(sender, options)
    sources = Sources(options)
    configure_gdb()

    try:
        gdb.execute("start")
    except gdb.error as exc:
        tracker.note("cannot start the program: %s" % exc)
        return

    if sources.mode == "list":
        try:
            _name, entry_file, _line = frame_location(gdb.newest_frame())
        except Exception:  # noqa: BLE001
            entry_file = None
        if not sources.is_user_file(entry_file):
            sources.use_heuristic(
                "the entry frame (%s) is not one of the known sources" % (entry_file or "unknown")
            )

    steps = 0
    max_steps = options["maxSteps"]

    def on_truncate(count, limit):
        # One stable message, so the tracker only sends it once.
        tracker.note("call stack is deeper than maxDepth=%d; deeper frames are hidden" % limit)

    while True:
        if not inferior_alive():
            break
        alive = None
        top = describe_top()
        top_returns = top is not None and at_return_instruction(top["frame"])
        top_identity = top["identity"] if top is not None else None
        if top is not None:
            alive = timed("update", lambda: tracker.apply_incremental(top, top_returns, on_truncate))
        if alive is None:
            frames = timed("snapshot", lambda: take_snapshot(sources, options["maxDepth"], on_truncate))
            if frames is None:
                break
            alive = timed("update", lambda: tracker.apply_full(frames, top_returns, top_identity))
        if not alive:
            log("stopping: the extension is gone")
            return
        if steps >= max_steps:
            tracker.note("reached maxSteps=%d, stopping the recording" % max_steps)
            break
        if not timed("step", step_once):
            break
        steps += 1
        if not timed("leave", lambda: return_to_user_code(sources)):
            break

    tracker.exit(exit_code())
    if TIMING:
        log(
            "timings: "
            + ", ".join("%s=%.2fs" % (phase, total) for phase, total in sorted(TIMINGS.items()))
        )
    log("finished after %d step(s), %d event(s) sent" % (steps, sender.count))


def main():
    options = load_options()
    sender = None
    try:
        sender = Sender(connect(options))
        run(options, sender)
    except Exception as exc:  # noqa: BLE001 - report instead of crashing gdb
        log("fatal: %s" % exc)
        if sender is not None:
            sender.send(synthetic_event("exception", "StackViz driver error: %s" % exc))
    finally:
        if sender is not None:
            sender.close()


if __name__ == "__main__":
    main()
