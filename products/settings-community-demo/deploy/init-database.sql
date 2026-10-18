SELECT format('CREATE DATABASE %I', :'demo_database')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'demo_database')
\gexec
