#!/bin/sh
# Arranca backend y frontend. Alternativa manual: dos terminales con
# `npm run dev -w server` y `npm run dev -w web`.
trap 'kill 0' EXIT INT TERM
npm run dev -w server &
npm run dev -w web &
wait
