// AV1b: the N-API face of the in-process Apple player (pipeline/apple-view.swift).
// Built by scripts/fetch-tools.sh into build/tools/apple-player.node. N-API is ABI
// stable, so the addon loads in Electron's main process without an Electron rebuild.
// Every call arrives on the main thread (Electron's main process thread is AppKit's).
// Events come back through one thread-safe function, unreferenced so it never keeps
// the app alive.
#define NAPI_VERSION 8
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

typedef void (*apv_emitter)(const char *);
extern void apv_set_emitter(apv_emitter fn);
extern int apv_attach(void *view);
extern void apv_load(const char *path, double at, int muted);
extern void apv_play(double at, double rate);
extern void apv_pause(void);
extern void apv_seek(double at);
extern void apv_set_rect(double x, double y, double w, double h, int frames);
extern void apv_set_visible(int visible);
extern void apv_set_muted(int muted);
extern void apv_set_look(const char *json);
extern void apv_warm(const char *json);
extern void apv_dispose(void);
extern char *apv_capture(const char *path, int nominal);
extern int apv_qa_below_desktop(void);
extern char *apv_qa_frame(const char *path);
extern char *apv_state(void);
extern char *apv_qa_readback(int full, double x, double y, double w, double h);
extern char *apv_qa_grab(const char *path);
extern char *apv_qa_probes(double after);

static napi_threadsafe_function events = NULL;

static void call_js(napi_env env, napi_value callback, void *context, void *data) {
  (void)context;
  char *text = data;
  if (env && callback && text) {
    napi_value argument, receiver;
    if (napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &argument) == napi_ok && napi_get_undefined(env, &receiver) == napi_ok)
      napi_call_function(env, receiver, callback, 1, &argument, NULL);
  }
  free(text);
}

static void emit(const char *text) {
  if (!events || !text) return;
  char *copy = strdup(text);
  if (!copy) return;
  if (napi_call_threadsafe_function(events, copy, napi_tsfn_nonblocking) != napi_ok) free(copy);
}

static int args(napi_env env, napi_callback_info info, size_t want, napi_value *out) {
  size_t count = want;
  if (napi_get_cb_info(env, info, &count, out, NULL, NULL) != napi_ok) return 0;
  for (size_t i = count; i < want; i++) napi_get_undefined(env, &out[i]);
  return 1;
}
static double number(napi_env env, napi_value value, double fallback) {
  double out;
  return napi_get_value_double(env, value, &out) == napi_ok ? out : fallback;
}
static char *string(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return NULL;
  char *out = malloc(length + 1);
  if (!out) return NULL;
  napi_get_value_string_utf8(env, value, out, length + 1, &length);
  return out;
}
static napi_value undefined(napi_env env) { napi_value out; napi_get_undefined(env, &out); return out; }
static napi_value json(napi_env env, char *text) {
  napi_value out;
  if (!text || napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &out) != napi_ok) out = undefined(env);
  free(text);
  return out;
}

static napi_value on_event(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!args(env, info, 1, argv)) return undefined(env);
  napi_valuetype type;
  napi_typeof(env, argv[0], &type);
  if (type != napi_function) { napi_throw_type_error(env, NULL, "onEvent needs a function"); return undefined(env); }
  if (events) { napi_release_threadsafe_function(events, napi_tsfn_abort); events = NULL; }
  napi_value name;
  napi_create_string_utf8(env, "apple-player-events", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[0], NULL, name, 0, 1, NULL, NULL, NULL, call_js, &events) == napi_ok) {
    napi_unref_threadsafe_function(env, events);
    apv_set_emitter(emit);
  }
  return undefined(env);
}

static napi_value attach(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!args(env, info, 1, argv)) return undefined(env);
  void *data = NULL; size_t length = 0;
  bool is_buffer = false;
  napi_is_buffer(env, argv[0], &is_buffer);
  if (!is_buffer || napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void *)) {
    napi_throw_type_error(env, NULL, "attach needs the window's native handle");
    return undefined(env);
  }
  void *view = *(void **)data;
  napi_value out;
  napi_create_int32(env, apv_attach(view), &out);
  return out;
}

static napi_value load(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  if (!args(env, info, 3, argv)) return undefined(env);
  char *path = string(env, argv[0]);
  bool muted = false;
  napi_get_value_bool(env, argv[2], &muted);
  apv_load(path ? path : "", number(env, argv[1], 0), muted ? 1 : 0);
  free(path);
  return undefined(env);
}
static napi_value play(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (args(env, info, 2, argv)) apv_play(number(env, argv[0], 0), number(env, argv[1], 1));
  return undefined(env);
}
static napi_value pause_(napi_env env, napi_callback_info info) { (void)info; apv_pause(); return undefined(env); }
static napi_value seek(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (args(env, info, 1, argv)) apv_seek(number(env, argv[0], 0));
  return undefined(env);
}
static napi_value set_rect(napi_env env, napi_callback_info info) {
  napi_value argv[5];
  if (args(env, info, 5, argv)) apv_set_rect(number(env, argv[0], 0), number(env, argv[1], 0), number(env, argv[2], 0), number(env, argv[3], 0), (int)number(env, argv[4], 0));
  return undefined(env);
}
static napi_value set_visible(napi_env env, napi_callback_info info) {
  napi_value argv[1]; bool visible = false;
  if (args(env, info, 1, argv)) napi_get_value_bool(env, argv[0], &visible);
  apv_set_visible(visible ? 1 : 0);
  return undefined(env);
}
static napi_value set_muted(napi_env env, napi_callback_info info) {
  napi_value argv[1]; bool muted = false;
  if (args(env, info, 1, argv)) napi_get_value_bool(env, argv[0], &muted);
  apv_set_muted(muted ? 1 : 0);
  return undefined(env);
}
static napi_value set_look(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!args(env, info, 1, argv)) return undefined(env);
  char *json = string(env, argv[0]);
  apv_set_look(json ? json : "{}");
  free(json);
  return undefined(env);
}
/* AV2: compile the Look shader ahead of the plan (off the main thread), so it is ready when the plan loads. */
static napi_value warm(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!args(env, info, 1, argv)) return undefined(env);
  char *json = string(env, argv[0]);
  apv_warm(json ? json : "{}");
  free(json);
  return undefined(env);
}
static napi_value dispose(napi_env env, napi_callback_info info) { (void)info; apv_dispose(); return undefined(env); }
static napi_value capture(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (!args(env, info, 2, argv)) return undefined(env);
  char *path = string(env, argv[0]);
  bool nominal = false;
  napi_get_value_bool(env, argv[1], &nominal);
  napi_value out = json(env, apv_capture(path ? path : "", nominal ? 1 : 0));
  free(path);
  return out;
}
static napi_value qa_below_desktop(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  napi_create_int32(env, apv_qa_below_desktop(), &out);
  return out;
}
static napi_value state(napi_env env, napi_callback_info info) { (void)info; return json(env, apv_state()); }
/* AV2 QA: the picture on screen, full size, with its Look, as a PNG. */
static napi_value qa_frame(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!args(env, info, 1, argv)) return undefined(env);
  char *path = string(env, argv[0]);
  napi_value out = json(env, apv_qa_frame(path ? path : ""));
  free(path);
  return out;
}

/* AV5 QA: read back what the presenter presented (see QaReadback in apple-view.swift). */
static napi_value qa_readback(napi_env env, napi_callback_info info) {
  napi_value argv[5];
  if (!args(env, info, 5, argv)) return undefined(env);
  bool full = false;
  napi_get_value_bool(env, argv[0], &full);
  return json(env, apv_qa_readback(full ? 1 : 0, number(env, argv[1], 0), number(env, argv[2], 0), number(env, argv[3], 0), number(env, argv[4], 0)));
}
static napi_value qa_grab(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!args(env, info, 1, argv)) return undefined(env);
  char *path = string(env, argv[0]);
  napi_value out = json(env, apv_qa_grab(path ? path : ""));
  free(path);
  return out;
}
static napi_value qa_probes(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!args(env, info, 1, argv)) return undefined(env);
  return json(env, apv_qa_probes(number(env, argv[0], 0)));
}

NAPI_MODULE_INIT() {
  const struct { const char *name; napi_callback fn; } methods[] = {
    {"onEvent", on_event}, {"attach", attach}, {"load", load}, {"play", play}, {"pause", pause_}, {"seek", seek},
    {"setRect", set_rect}, {"setVisible", set_visible}, {"setMuted", set_muted}, {"setLook", set_look}, {"warm", warm}, {"dispose", dispose},
    {"capture", capture}, {"qaBelowDesktop", qa_below_desktop}, {"state", state}, {"qaFrame", qa_frame},
    {"qaReadback", qa_readback}, {"qaGrab", qa_grab}, {"qaProbes", qa_probes},
  };
  for (size_t i = 0; i < sizeof(methods) / sizeof(methods[0]); i++) {
    napi_value fn;
    if (napi_create_function(env, methods[i].name, NAPI_AUTO_LENGTH, methods[i].fn, NULL, &fn) == napi_ok)
      napi_set_named_property(env, exports, methods[i].name, fn);
  }
  return exports;
}
