<script setup lang="ts">
import { withBase } from 'vitepress'

defineProps<{ platform: string }>()
</script>

<template>
  <img
    class="platform-logo"
    :src="withBase(`/platforms/${platform}.svg`)"
    alt=""
    aria-hidden="true"
    width="24"
    height="24"
  />
</template>
