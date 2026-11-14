/*
 * A stand-in for Chromium's libvk_swiftshader.so that hands WebGPU to Mesa's
 * lavapipe (tools/browser/launch.mjs builds and installs it; see there).
 *
 * Without a GPU, Chromium's WebGPU runs on SwiftShader, which it opens next to
 * its binary as libvk_swiftshader.so and asks for vkGetInstanceProcAddr.
 * SwiftShader cannot run Bearing: the tile synthesizer's compute kernels never
 * finish there and the GPU process grows until the kernel kills it. Lavapipe
 * runs them (Node's Dawn uses it for the GPU tests and previews), but it
 * exports only the entry points of a Vulkan driver behind a loader, and
 * Chromium takes a software adapter only if it says it is SwiftShader.
 *
 * So this library forwards every lookup to lavapipe and changes two numbers
 * in the answer of vkGetPhysicalDeviceProperties(2): the vendor and device id
 * become SwiftShader's (0x1AE0, 0xC0DE). LVP_SHIM_LIB names the driver
 * (default /usr/lib/x86_64-linux-gnu/libvulkan_lvp.so).
 *
 *   gcc -shared -fPIC -O1 -o libvk_swiftshader.so lvpshim.c -ldl
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void (*Fn)(void);
typedef Fn (*Lookup)(void *, const char *);

static void *driver;
static Lookup instanceProc;
static Lookup physicalDeviceProc;
static int (*negotiate)(uint32_t *);
static void (*properties)(void *, uint32_t *);
static void (*properties2)(void *, void *);

static void load(void) {
  if (driver) return;
  const char *path = getenv("LVP_SHIM_LIB");
  if (!path) path = "/usr/lib/x86_64-linux-gnu/libvulkan_lvp.so";
  driver = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!driver) {
    fprintf(stderr, "lvpshim: cannot open %s: %s\n", path, dlerror());
    abort();
  }
  instanceProc = (Lookup)dlsym(driver, "vk_icdGetInstanceProcAddr");
  physicalDeviceProc = (Lookup)dlsym(driver, "vk_icdGetPhysicalDeviceProcAddr");
  negotiate = (int (*)(uint32_t *))dlsym(driver, "vk_icdNegotiateLoaderICDInterfaceVersion");
  if (!instanceProc) {
    fprintf(stderr, "lvpshim: %s is no Vulkan driver\n", path);
    abort();
  }
  uint32_t version = 5;
  if (negotiate) negotiate(&version);
  fprintf(stderr, "lvpshim: WebGPU runs on %s\n", path);
}

/* VkPhysicalDeviceProperties begins: apiVersion, driverVersion, vendorID, deviceID. */
static void asSwiftShader(uint32_t *p) {
  p[2] = 0x1AE0;
  p[3] = 0xC0DE;
}

static void getProperties(void *device, uint32_t *p) {
  properties(device, p);
  asSwiftShader(p);
}

/* VkPhysicalDeviceProperties2: sType, pNext, then the properties (at byte 16). */
static void getProperties2(void *device, void *p) {
  properties2(device, p);
  asSwiftShader((uint32_t *)((char *)p + 16));
}

static Fn lookup(void *instance, const char *name) {
  load();
  Fn f = instanceProc(instance, name);
  if (!f) return f;
  if (!strcmp(name, "vkGetPhysicalDeviceProperties")) {
    properties = (void (*)(void *, uint32_t *))f;
    return (Fn)getProperties;
  }
  if (!strcmp(name, "vkGetPhysicalDeviceProperties2") ||
      !strcmp(name, "vkGetPhysicalDeviceProperties2KHR")) {
    properties2 = (void (*)(void *, void *))f;
    return (Fn)getProperties2;
  }
  return f;
}

#define EXPORT __attribute__((visibility("default")))

EXPORT Fn vkGetInstanceProcAddr(void *instance, const char *name) { return lookup(instance, name); }
EXPORT Fn vk_icdGetInstanceProcAddr(void *instance, const char *name) { return lookup(instance, name); }
EXPORT Fn vk_icdGetPhysicalDeviceProcAddr(void *instance, const char *name) {
  load();
  return physicalDeviceProc ? physicalDeviceProc(instance, name) : 0;
}
EXPORT int vk_icdNegotiateLoaderICDInterfaceVersion(uint32_t *version) {
  load();
  return negotiate ? negotiate(version) : 0;
}
