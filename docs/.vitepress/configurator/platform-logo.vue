<script setup lang="ts">
defineProps<{ platform: string }>()

const logos = import.meta.glob<string>('./logos/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
})
</script>

<template>
  <img
    v-if="logos[`./logos/${platform}.svg`]"
    class="platform-logo"
    :src="logos[`./logos/${platform}.svg`]"
    alt=""
    aria-hidden="true"
    width="24"
    height="24"
  />
  <span v-else class="platform-logo" aria-hidden="true">{{
    platform.charAt(0).toUpperCase()
  }}</span>
</template>
