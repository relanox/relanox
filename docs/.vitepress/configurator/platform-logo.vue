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
    class="platform-logo"
    :src="logos[`./logos/${platform}.svg`]"
    alt=""
    aria-hidden="true"
    width="24"
    height="24"
  />
</template>
