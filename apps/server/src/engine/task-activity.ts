/** Short presentation labels; internal tool instructions never enter the activity feed. */
export function taskActivity(name: string) {
  if (/^(todo_list|set_plan)$/.test(name)) return "Updating the plan";
  if (/^(search_web|browser_research)$/.test(name)) return "Searching for sources";
  if (/^(web_fetch|web_extract|read_web_data|read_web)$/.test(name)) return "Reading sources";
  if (/^(generate_image|image_generation_status)$/.test(name)) return "Creating the image";
  if (name === "organize_gmail") return "Organizing Gmail";
  if (name === "prepare_gmail_trash") return "Preparing the next step";
  if (name === "create_document") return "Creating the document";
  if (/^(inspect_document|confirm_document_review|view_file)$/.test(name))
    return "Checking the result";
  if (name === "finish_task") return "Checking and preparing the delivery";
  if (name === "ask_user") return "Waiting for your answer";
  if (/^(search_tools|describe_tools|search_app_tools|skills_|read_runtime)/.test(name))
    return "Preparing the next step";
  if (/^(browser_|desktop_)/.test(name)) return "Using the computer";
  if (/computer|command/.test(name)) return "Running the requested work";
  return "Working on your request";
}
