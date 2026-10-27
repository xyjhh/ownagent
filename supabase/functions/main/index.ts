Deno.serve(() => Response.json({ error: 'Function not found' }, { status: 404 }))
