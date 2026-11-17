-- run once: make Mya's account the advisor
update public.profiles set role = 'advisor', full_name = 'Mya Ferrera', username = 'mya', must_set_login = false
where id = '52997f13-77b6-4c97-a162-ea3c6e6d8bab';
